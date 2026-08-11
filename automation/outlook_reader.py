"""
outlook_reader.py — Read/write emails via Outlook desktop (win32com) or Microsoft Graph API.

Actions: status, mailboxes, emails, email, save-attachment, send-reply, get-attachment,
         flag, mark-unread, delete, forward, open-in-outlook, categorize,
         suggest-attachments, reply-with-attachments, send-new, graph-connect
Output: JSON to stdout
"""
import sys, json, os, re, argparse, tempfile, base64, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ─── Microsoft Graph config ───────────────────────────────────────────────────
GRAPH_CLIENT_ID = '989acbd6-c876-4e62-b02f-f6d97f872fdd'
GRAPH_TENANT_ID = 'd6525c95-b906-431a-b926-e9b51ba43cc4'
GRAPH_AUTHORITY = f'https://login.microsoftonline.com/{GRAPH_TENANT_ID}'
GRAPH_SCOPES    = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/User.Read',
]
GRAPH_CACHE     = os.path.join(SCRIPT_DIR, 'graph_token_cache.json')
GRAPH_BASE      = 'https://graph.microsoft.com/v1.0'

# ─── IMAP / SMTP config ───────────────────────────────────────────────────────
IMAP_CONFIG = os.path.join(SCRIPT_DIR, 'imap_config.json')


# ─── win32com helpers (Classic Outlook) ──────────────────────────────────────
def get_outlook_ns():
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    outlook = win32com.client.Dispatch("Outlook.Application")
    return outlook, outlook.GetNamespace("MAPI")


INBOX_NAMES = {
    'inbox', 'boîte de réception', 'posteingang',
    'bandeja de entrada', 'postvak in', 'gelen kutusu',
    'входящие', 'posta in arrivo',
}


def find_inbox(root_folder):
    for j in range(1, root_folder.Folders.Count + 1):
        f = root_folder.Folders.Item(j)
        if f.Name.lower() in INBOX_NAMES:
            return f
    return None


_IMG_EXTS = ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff')

# MAPI property tags: content-id (inline reference) + hidden-attachment flag.
_PR_ATTACH_CONTENT_ID = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"
_PR_ATTACHMENT_HIDDEN = "http://schemas.microsoft.com/mapi/proptag/0x7FFE000B"


def att_info(att):
    name  = att.FileName or ''
    lower = name.lower()
    # Inline (embedded in the HTML body) vs a real file attachment. Inline images
    # carry a Content-ID and/or the hidden flag; we auto-feed those to the AI and
    # use the Content-ID to swap cid: refs in the HTML body for real image URLs.
    content_id = ''
    is_inline = False
    try:
        content_id = str(att.PropertyAccessor.GetProperty(_PR_ATTACH_CONTENT_ID) or '')
        is_inline = bool(content_id)
    except Exception:
        try:
            is_inline = bool(att.PropertyAccessor.GetProperty(_PR_ATTACHMENT_HIDDEN))
        except Exception:
            is_inline = False
    return {
        'index':     att.Index,
        'name':      name,
        'size':      att.Size,
        'isPdf':     lower.endswith('.pdf'),
        'isImage':   lower.endswith(_IMG_EXTS),
        'isInline':  is_inline,
        'contentId': content_id.strip('<>'),
    }


# Resolving an Exchange /O=… DN costs a directory round-trip per message. Whole-
# mailbox sweeps hit the same few hundred senders thousands of times, so memoise
# the DN → SMTP answer for the life of the process (one CLI action = one process,
# so this can never go stale).
_SMTP_CACHE = {}


def resolve_smtp(item):
    """Return the real SMTP address, resolving Exchange internal /O=... format."""
    try:
        addr = item.SenderEmailAddress or ''
        if not addr or not (addr.upper().startswith('/O=') or addr.upper().startswith('EX:')):
            return addr
        hit = _SMTP_CACHE.get(addr)
        if hit is not None:
            return hit
        sender = item.Sender
        if sender:
            try:
                ex_user = sender.GetExchangeUser()
                if ex_user:
                    smtp = ex_user.PrimarySmtpAddress
                    if smtp:
                        _SMTP_CACHE[addr] = smtp
                        return smtp
            except Exception:
                pass
            try:
                ex_dl = sender.GetExchangeDistributionList()
                if ex_dl:
                    smtp = ex_dl.PrimarySmtpAddress
                    if smtp:
                        _SMTP_CACHE[addr] = smtp
                        return smtp
            except Exception:
                pass
        _SMTP_CACHE[addr] = addr      # unresolvable — don't retry it per message
        return addr
    except Exception:
        return getattr(item, 'SenderEmailAddress', '') or ''


def email_summary(item):
    try:
        atts = [att_info(item.Attachments.Item(k))
                for k in range(1, item.Attachments.Count + 1)]
        return {
            'entryId':     item.EntryID,
            'subject':     item.Subject or '(no subject)',
            'sender':      item.SenderName or '',
            'senderEmail': resolve_smtp(item),
            'received':    str(item.ReceivedTime),
            'bodyPreview': (item.Body or '')[:300].strip(),
            'unread':      bool(item.UnRead),
            'attachments': atts,
            'hasPdf':      any(a['isPdf'] for a in atts),
        }
    except Exception:
        return None


def _score(subject, body, sf_id, qn_words):
    text = (subject + ' ' + body).lower()
    score = 0
    if sf_id and sf_id.lower() in text:
        score += 10
    score += sum(1 for w in qn_words if w in text)
    return score


SENT_NAMES = {
    'sent items', 'sent', 'éléments envoyés', 'gesendete elemente',
    'enviados', 'verzonden', 'gönderilenler', 'отправленные', 'posta inviata',
}


def _all_inboxes(ns):
    inboxes = []
    try:
        inboxes.append(ns.GetDefaultFolder(6))
    except Exception:
        pass
    try:
        for i in range(1, ns.Stores.Count + 1):
            store = ns.Stores.Item(i)
            root  = store.GetRootFolder()
            for j in range(1, root.Folders.Count + 1):
                f = root.Folders.Item(j)
                if f.Name.lower() in INBOX_NAMES:
                    inboxes.append(f)
                    break
    except Exception:
        pass
    return inboxes


# Folders that never hold finished work — skipped by the recursive walkers below.
# Matched on the lowercase folder name, so the localised variants are listed too.
SKIP_FOLDER_NAMES = {
    'deleted items', 'éléments supprimés', 'gelöschte elemente', 'verwijderde items',
    'junk email', 'junk e-mail', 'courrier indésirable', 'junk-e-mail',
    'drafts', 'brouillons', 'entwürfe', 'concepten',
    'outbox', 'boîte d\'envoi', 'postausgang',
    'rss feeds', 'rss-feeds', 'sync issues', 'problèmes de synchronisation',
    'conversation history', 'historique des conversations', 'unterhaltungsverlauf',
    'quick step settings', 'yammer root', 'files', 'clutter', 'archive log',
}

# Quote-carrying attachment types — the same set the Dashboard dropzone accepts.
QUOTE_DOC_EXTS = ('.pdf', '.xlsx', '.xls', '.xlsm', '.docx', '.doc', '.dotm', '.dotx')

# Machine-generated mail: out-of-office bounces, ticket acknowledgements, NDRs,
# meeting-response receipts. These are not work done — counting them inflates the
# job report, and worse, letting one become a thread's body sample makes the
# classifier describe the auto-reply instead of the actual job.
AUTO_SUBJECT_RE = re.compile(
    r'^\s*(?:automatic reply|auto(?:matic)?[- ]?response|out of office|'
    r'r[ée]ponse automatique|automatische antwort|abwesenheitsnotiz|'
    r'undeliverable|delivery status notification|delivery has failed|'
    r'read:|not read:|accepted:|declined:|tentative:)', re.I)
AUTO_SENDER_RE = re.compile(r'no-?reply|do-?not-?reply|postmaster|mailer-daemon|autoreply', re.I)


def is_auto_message(item, subject, smtp):
    """True when the message was generated by a machine, not written by a person."""
    if AUTO_SUBJECT_RE.search(subject or ''):
        return True
    if AUTO_SENDER_RE.search(smtp or ''):
        return True
    try:
        cls = (item.MessageClass or '')
        # OOF templates and non-delivery reports carry their own message classes.
        if 'oof' in cls.lower() or cls.startswith('REPORT.'):
            return True
    except Exception:
        pass
    return False

# Salesforce/case references as they appear in quote mail. Two shapes are in the
# wild: the short form the notification mails carry (SR00…, CR00…, EU00…) and the
# expanded 18-char id SharePoint stores (006QO00000…). Both normalise to the same
# key in normalize_ref() so a match works whichever form the email used.
#
# The boundaries are explicit [A-Za-z0-9] lookarounds, NOT \b. Eaton joins these
# ids to the rest of a subject/filename with underscores ("SR00123456_ACME.pdf"),
# and `_` is a word character — so \b never fires there and every underscore-
# joined reference would be silently missed.
REF_RE = re.compile(
    r'(?<![A-Za-z0-9])'
    r'(?:006QO00000[A-Za-z0-9]{4,8}|(?:SR|CR|EU|ER|QR|OP)00[A-Za-z0-9]{4,14})'
    r'(?![A-Za-z0-9])')


# BidManager quote numbers — QW28237, QB27005A2R, QW27351A. These are the MAIN
# identifier on manualnotification quote mail, and they are NOT Salesforce ids:
# in the Quotations List they live in Title, with SALESFORCEID often empty. So
# they need their own lookup path or a BidManager quote can never be verified.
BM_REF_RE = re.compile(
    r'(?<![A-Za-z0-9])((?:QW|QB|QT)\d{4,6})([A-Za-z]\d?[A-Za-z]?)?(?![A-Za-z0-9])',
    re.I)


def bm_base(ref):
    """'QB27005A2R' -> 'QB27005' — the revision suffix is not part of the number."""
    m = BM_REF_RE.match(ref or '')
    return (m.group(1).upper() if m else (ref or '').upper())


def find_bm_refs(text):
    """Unique BidManager numbers in `text`, as [{'raw':…, 'base':…}]."""
    out, seen = [], set()
    for m in BM_REF_RE.finditer(text or ''):
        base = m.group(1).upper()
        if base in seen:
            continue
        seen.add(base)
        out.append({'raw': m.group(0), 'base': base})
    return out


def normalize_ref(ref):
    """Mirror of Automation_V4.normalize_sfid — strip revision suffix, expand short form."""
    if not ref:
        return ref
    ref = ref.strip()
    if '-' in ref:
        ref = ref.split('-')[0]
    if len(ref) >= 4 and ref[2:4] == '00' and ref[:2].isalpha():
        ref = '006QO00000' + ref[4:]
    return ref


def folder_path(f):
    """'Mailbox\\Inbox\\Sub' — walks up the parent chain, defensively."""
    parts = []
    cur   = f
    for _ in range(12):          # hard depth cap; a corrupt chain must not spin
        try:
            name = cur.Name
        except Exception:
            break
        if not name:
            break
        parts.append(name)
        try:
            cur = cur.Parent
        except Exception:
            break
        if cur is None:
            break
    return '\\'.join(reversed(parts))


def walk_folders(root, max_depth=8, skip=True, _depth=0):
    """Yield `root` and every mail subfolder beneath it, depth-first.

    Only real mail folders are yielded (DefaultItemType 0), so Calendar,
    Contacts and Tasks folders the user nested under Inbox are ignored.
    """
    if _depth > max_depth:
        return
    try:
        if skip and root.Name and root.Name.lower() in SKIP_FOLDER_NAMES:
            return
    except Exception:
        pass
    try:
        # 0 = olMailItem. Some stores raise on this property; assume mail if so.
        if root.DefaultItemType == 0:
            yield root
    except Exception:
        yield root
    try:
        count = root.Folders.Count
    except Exception:
        return
    for i in range(1, count + 1):
        try:
            sub = root.Folders.Item(i)
        except Exception:
            continue
        for f in walk_folders(sub, max_depth, skip, _depth + 1):
            yield f


def work_stores(ns):
    """Every store that can hold this user's work, newest-usable first.

    Deliberately excludes Public Folders: it is an org-wide tree, enormous, and
    holds nobody's job history. A store whose root cannot be opened (Exchange
    returns "RPC server is unavailable" for a mailbox that is momentarily busy or
    not cached) is skipped with a warning rather than killing the whole sweep —
    losing one store must not silently produce an empty report.
    """
    out = []
    try:
        count = ns.Stores.Count
    except Exception:
        return out
    for i in range(1, count + 1):
        try:
            store = ns.Stores.Item(i)
            name  = store.DisplayName or ''
        except Exception:
            continue
        if 'public folder' in name.lower():
            continue
        try:
            root = store.GetRootFolder()
        except Exception as e:
            sys.stderr.write(f'[stores] skipped {name!r}: {e}\n')
            continue
        out.append((name, root))
    return out


def _item_date(item):
    """Best available timestamp — sent items can have an unset ReceivedTime."""
    for prop in ('ReceivedTime', 'SentOn', 'CreationTime', 'LastModificationTime'):
        try:
            d = getattr(item, prop, None)
            if d:
                return d
        except Exception:
            continue
    return None


def _date_tuple(d):
    """(y, m, d) from a COM date. Compared as a tuple so the tz-aware pywintypes
    value never has to meet a naive datetime — that comparison raises."""
    try:
        return (int(d.year), int(d.month), int(d.day))
    except Exception:
        return None


def _parse_ddmmyyyy(s):
    """'DD/MM/YYYY' → (y, m, d), or None."""
    m = re.match(r'^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*$', s or '')
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        datetime.date(y, mo, d)
    except ValueError:
        return None
    return (y, mo, d)


def _restrict_since(items, since_str, until_str='', with_attachment=False):
    """Apply a [ReceivedTime] restriction, falling back to the full set.

    `with_attachment` adds a DASL hasattachment clause so Outlook's own index
    does the narrowing — on a mailbox where most mail carries no document that
    is the difference between touching every item from Python and touching a
    handful. Falls back to the plain date filter if the store rejects DASL.
    """
    if with_attachment:
        try:
            dasl = (f'@SQL="urn:schemas:httpmail:datereceived" >= \'{since_str} 00:00\''
                    ' AND "urn:schemas:httpmail:hasattachment" = 1')
            if until_str:
                dasl += f' AND "urn:schemas:httpmail:datereceived" <= \'{until_str} 23:59\''
            return items.Restrict(dasl)
        except Exception:
            pass
    try:
        clause = f"[ReceivedTime] >= '{since_str} 00:00'"
        if until_str:
            clause += f" AND [ReceivedTime] <= '{until_str} 23:59'"
        return items.Restrict(clause)
    except Exception:
        return items


def _folders_for_att_search(ns):
    """Inbox + sent items + 1-level inbox subfolders across all stores."""
    folders = []
    seen    = set()

    def add(f):
        try:
            fid = f.EntryID
            if fid in seen:
                return
            seen.add(fid)
            folders.append(f)
        except Exception:
            pass

    for folder_id in (6, 5):
        try:
            add(ns.GetDefaultFolder(folder_id))
        except Exception:
            pass

    try:
        for i in range(1, ns.Stores.Count + 1):
            store = ns.Stores.Item(i)
            root  = store.GetRootFolder()
            for j in range(1, root.Folders.Count + 1):
                f     = root.Folders.Item(j)
                fname = f.Name.lower()
                if fname in INBOX_NAMES or fname in SENT_NAMES:
                    add(f)
                    try:
                        for k in range(1, f.Folders.Count + 1):
                            add(f.Folders.Item(k))
                    except Exception:
                        pass
    except Exception:
        pass

    return folders


# ─── Graph API helpers ────────────────────────────────────────────────────────
def _gapp():
    import msal
    cache = msal.SerializableTokenCache()
    if os.path.exists(GRAPH_CACHE):
        try:
            from cookie_crypto import load_token
            data = load_token(GRAPH_CACHE)            # encrypted at rest
            if data:
                cache.deserialize(data)
        except Exception:
            pass
    app = msal.PublicClientApplication(
        GRAPH_CLIENT_ID, authority=GRAPH_AUTHORITY, token_cache=cache)
    return app, cache


def _save_gcache(cache):
    if cache.has_state_changed:
        try:
            from cookie_crypto import save_token
            save_token(GRAPH_CACHE, cache.serialize())
        except Exception:
            open(GRAPH_CACHE, 'w').write(cache.serialize())


def _gtoken():
    """Return a valid access token via silent refresh, or None if re-auth needed."""
    try:
        app, cache = _gapp()
        accs = app.get_accounts()
        if accs:
            r = app.acquire_token_silent(GRAPH_SCOPES, account=accs[0])
            _save_gcache(cache)
            if r and 'access_token' in r:
                return r['access_token']
    except Exception:
        pass
    return None


def _ghdr(token):
    return {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}


def _gget(token, path, params=None):
    import requests as rq
    r = rq.get(GRAPH_BASE + path, headers=_ghdr(token), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def _gpost(token, path, body=None):
    import requests as rq
    r = rq.post(GRAPH_BASE + path, headers=_ghdr(token), json=body or {}, timeout=30)
    r.raise_for_status()
    return r


def _gpatch(token, path, body):
    import requests as rq
    rq.patch(GRAPH_BASE + path, headers=_ghdr(token), json=body, timeout=30).raise_for_status()


def _gdel(token, path):
    import requests as rq
    rq.delete(GRAPH_BASE + path, headers=_ghdr(token), timeout=30).raise_for_status()


def _gget_raw(token, path):
    import requests as rq
    r = rq.get(GRAPH_BASE + path,
               headers={'Authorization': f'Bearer {token}'}, timeout=60)
    r.raise_for_status()
    return r.content


def _is_new_outlook():
    try:
        import subprocess
        r = subprocess.run(
            ['tasklist', '/FI', 'IMAGENAME eq olk.exe', '/FO', 'CSV', '/NH'],
            capture_output=True, text=True, timeout=5)
        return 'olk.exe' in r.stdout.lower()
    except Exception:
        return False


def _graph_att_info(att, idx):
    name = att.get('name', '') or ''
    lower = name.lower()
    return {
        'index':    idx,
        'name':     name,
        'size':     att.get('size', 0),
        'isPdf':     lower.endswith('.pdf'),
        'isImage':   lower.endswith(_IMG_EXTS),
        'isInline':  bool(att.get('isInline') or att.get('contentId')),
        'contentId': str(att.get('contentId') or '').strip('<>'),
        'graphId':   att.get('id', ''),
    }


def _graph_att_list(token, msg_id):
    data = _gget(token, f'/me/messages/{msg_id}/attachments',
                 params={'$select': 'id,name,size,contentType,isInline,contentId'})
    return [_graph_att_info(a, i + 1) for i, a in enumerate(data.get('value', []))]


def _graph_summary(msg):
    frm  = msg.get('from', {}).get('emailAddress', {})
    # Attachment info only available if $expand was used in query
    raw_atts = msg.get('attachments', [])
    if raw_atts:
        atts = [_graph_att_info(a, i + 1) for i, a in enumerate(raw_atts)]
    elif msg.get('hasAttachments'):
        atts = [{'index': 1, 'name': '', 'size': 0, 'isPdf': False, 'graphId': ''}]
    else:
        atts = []
    return {
        'entryId':     msg['id'],
        'subject':     msg.get('subject') or '(no subject)',
        'sender':      frm.get('name', ''),
        'senderEmail': frm.get('address', ''),
        'received':    msg.get('receivedDateTime', ''),
        'bodyPreview': msg.get('bodyPreview', ''),
        'unread':      not msg.get('isRead', True),
        'attachments': atts,
        'hasPdf':      any(a.get('isPdf') for a in atts),
    }


def _use_graph(backend):
    """True if Graph API should be used for this invocation."""
    if backend == 'graph':
        return True
    if backend == 'win32':
        return False
    # auto: use Graph if a cached token exists (means user already authenticated)
    return bool(_gtoken())


# ─── IMAP / SMTP helpers ──────────────────────────────────────────────────────
def _imap_cfg():
    try:
        if os.path.exists(IMAP_CONFIG):
            return json.load(open(IMAP_CONFIG))
    except Exception:
        pass
    return None


def _decode_hdr(v):
    from email.header import decode_header
    if not v:
        return ''
    parts = decode_header(v)
    result = []
    for part, enc in parts:
        if isinstance(part, bytes):
            result.append(part.decode(enc or 'utf-8', errors='replace'))
        else:
            result.append(str(part))
    return ''.join(result)


def _imap_connect(cfg):
    import imaplib
    server = cfg.get('imap_server', 'outlook.office365.com')
    port   = int(cfg.get('imap_port', 993))

    # Try NTLM with Windows SSPI (uses the current domain login — no password needed)
    if cfg.get('auth_type', 'auto') in ('auto', 'ntlm'):
        try:
            import sspi  # from pywin32
            imap = imaplib.IMAP4_SSL(server, port)
            _client = sspi.ClientAuth('NTLM')

            def _ntlm_cb(challenge):
                error, out = _client.authorize(None if challenge == b'' else challenge)
                return bytes(out[0].Buffer)

            typ, dat = imap.authenticate('NTLM', _ntlm_cb)
            if typ == 'OK':
                return imap          # success via NTLM — no password used
            imap.logout()
        except Exception:
            pass  # NTLM not available or rejected; fall through to basic auth

    # Basic auth (password required)
    if cfg.get('password'):
        imap = imaplib.IMAP4_SSL(server, port)
        imap.login(cfg['email'], cfg['password'])
        return imap

    raise Exception(
        'Windows login (NTLM) failed and no password provided. '
        'Try an App Password: go to mysignins.microsoft.com/security-info → Add method → App password.'
    )


def _smtp_connect(cfg):
    import smtplib
    smtp = smtplib.SMTP(cfg.get('smtp_server', 'smtp.office365.com'), int(cfg.get('smtp_port', 587)))
    smtp.ehlo()
    smtp.starttls()
    smtp.login(cfg['email'], cfg['password'])
    return smtp


def _imap_fetch_msg(imap, uid_str):
    import email as emaillib
    typ, data = imap.uid('fetch', uid_str.encode() if isinstance(uid_str, str) else uid_str, '(RFC822)')
    if typ != 'OK' or not data or not data[0]:
        raise Exception(f'Could not fetch message UID {uid_str}')
    raw = data[0][1] if isinstance(data[0], tuple) else data[0]
    return emaillib.message_from_bytes(raw)


def _imap_att_list(msg):
    atts = []
    idx = 1
    for part in msg.walk():
        if part.get_content_maintype() == 'multipart':
            continue
        fname = part.get_filename()
        if fname:
            fname = _decode_hdr(fname)
            content = part.get_payload(decode=True) or b''
            lower = fname.lower()
            disp  = (part.get('Content-Disposition') or '').lower()
            atts.append({
                'index': idx, 'name': fname, 'size': len(content),
                'isPdf':     lower.endswith('.pdf'),
                'isImage':   lower.endswith(_IMG_EXTS),
                'isInline':  'inline' in disp or bool(part.get('Content-ID')),
                'contentId': str(part.get('Content-ID') or '').strip('<>'),
            })
        idx += 1
    return atts


def _imap_body(msg):
    plain = ''
    html = ''
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if part.get_filename():
                continue
            enc = part.get_content_charset() or 'utf-8'
            if ct == 'text/plain' and not plain:
                try:
                    plain = part.get_payload(decode=True).decode(enc, errors='replace')
                except Exception:
                    pass
            elif ct == 'text/html' and not html:
                try:
                    html = part.get_payload(decode=True).decode(enc, errors='replace')
                except Exception:
                    pass
    else:
        enc = msg.get_content_charset() or 'utf-8'
        try:
            content = msg.get_payload(decode=True).decode(enc, errors='replace')
            if msg.get_content_type() == 'text/html':
                html = content
            else:
                plain = content
        except Exception:
            pass
    if not plain and html:
        plain = re.sub(r'<[^>]+>', ' ', html)
        plain = re.sub(r'[ \t]+', ' ', plain).strip()
    return plain[:6000], html


# ─── IMAP action dispatcher ───────────────────────────────────────────────────
def _imap_action(args, cfg):

    if args.action == 'mailboxes':
        print(json.dumps({'mailboxes': [{
            'storeId': 'imap:inbox', 'name': cfg['email'],
            'type': 'personal', 'inboxName': 'INBOX',
        }]}))
        return

    if args.action == 'emails':
        try:
            imap = _imap_connect(cfg)
            imap.select('INBOX', readonly=True)
            criteria = 'UNSEEN' if args.unread else 'ALL'
            typ, data = imap.uid('search', None, criteria)
            uids = data[0].split() if data[0] else []
            uids = list(reversed(uids))[:args.limit]

            emails = []
            if uids:
                uid_str = b','.join(uids)
                typ, fetch_data = imap.uid(
                    'fetch', uid_str,
                    '(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
                for item in fetch_data:
                    if not isinstance(item, tuple):
                        continue
                    meta = item[0].decode('ascii', errors='replace')
                    header_bytes = item[1]

                    uid_m = re.search(r'UID (\d+)', meta)
                    if not uid_m:
                        continue
                    uid_val = uid_m.group(1)

                    flags_m = re.search(r'FLAGS \(([^)]*)\)', meta)
                    flags = flags_m.group(1) if flags_m else ''
                    unread = '\\Seen' not in flags

                    import email as emaillib
                    from email.utils import parseaddr
                    msg = emaillib.message_from_bytes(header_bytes)
                    subject = _decode_hdr(msg.get('Subject', '(no subject)'))
                    from_raw = _decode_hdr(msg.get('From', ''))
                    sender_name, sender_email = parseaddr(from_raw)

                    try:
                        from email.utils import parsedate_to_datetime
                        received = parsedate_to_datetime(msg.get('Date', '')).isoformat()
                    except Exception:
                        received = msg.get('Date', '')

                    emails.append({
                        'entryId': f'imap:{uid_val}',
                        'subject': subject or '(no subject)',
                        'sender': sender_name or sender_email,
                        'senderEmail': sender_email,
                        'received': received,
                        'bodyPreview': '',
                        'unread': unread,
                        'attachments': [],
                        'hasPdf': False,
                    })

            imap.logout()
            print(json.dumps({'emails': emails}))
        except Exception as e:
            print(json.dumps({'emails': [], 'error': str(e)}))
        return

    if args.action == 'email':
        if not args.id:
            print(json.dumps({'error': 'No entry ID provided'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            msg = _imap_fetch_msg(imap, uid_str)

            try:
                imap.uid('store', uid_str.encode(), '+FLAGS', '(\\Seen)')
            except Exception:
                pass

            from email.utils import parseaddr
            sender_name, sender_email = parseaddr(_decode_hdr(msg.get('From', '')))
            plain, html = _imap_body(msg)
            atts = _imap_att_list(msg)

            try:
                from email.utils import parsedate_to_datetime
                received = parsedate_to_datetime(msg.get('Date', '')).isoformat()
            except Exception:
                received = msg.get('Date', '')

            typ, flag_data = imap.uid('fetch', uid_str.encode(), '(FLAGS)')
            flagged = False
            if flag_data and flag_data[0]:
                flagged = '\\Flagged' in (flag_data[0] if isinstance(flag_data[0], str)
                                          else flag_data[0].decode('ascii', errors='replace'))

            imap.logout()
            print(json.dumps({
                'entryId':     args.id,
                'subject':     _decode_hdr(msg.get('Subject', '(no subject)')),
                'sender':      sender_name or sender_email,
                'senderEmail': sender_email,
                'to':          _decode_hdr(msg.get('To', '')),
                'cc':          _decode_hdr(msg.get('Cc', '')),
                'received':    received,
                'body':        plain,
                'htmlBody':    html,
                'unread':      False,
                'attachments': atts,
                'hasPdf':      any(a['isPdf'] for a in atts),
                'flagged':     flagged,
                'categories':  '',
                '_msgId':      msg.get('Message-ID', ''),
            }))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'save-attachment':
        if not args.id or not args.dest:
            print(json.dumps({'error': 'entryId and dest required'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            msg = _imap_fetch_msg(imap, uid_str)
            imap.logout()
            os.makedirs(args.dest, exist_ok=True)
            saved = []
            for part in msg.walk():
                fname = part.get_filename()
                if not fname:
                    continue
                fname = _decode_hdr(fname)
                if fname.lower().endswith('.pdf'):
                    content = part.get_payload(decode=True) or b''
                    dest_path = os.path.join(args.dest, fname)
                    open(dest_path, 'wb').write(content)
                    saved.append({'name': fname, 'path': dest_path})
            print(json.dumps({'saved': saved, 'count': len(saved)}))
        except Exception as e:
            print(json.dumps({'error': str(e), 'saved': []}))
        return

    if args.action == 'get-attachment':
        if not args.id or not args.dest or not args.index:
            print(json.dumps({'error': 'entryId, dest and index required'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            msg = _imap_fetch_msg(imap, uid_str)
            imap.logout()
            att_parts = [p for p in msg.walk() if not p.is_multipart() and p.get_filename()]
            if args.index < 1 or args.index > len(att_parts):
                print(json.dumps({'error': f'Attachment index {args.index} out of range'}))
                return
            part = att_parts[args.index - 1]
            fname = _decode_hdr(part.get_filename())
            content = part.get_payload(decode=True) or b''
            os.makedirs(args.dest, exist_ok=True)
            safe = fname.replace('/', '_').replace('\\', '_')
            dest_path = os.path.join(args.dest, f'att_{abs(hash(args.id)) % 100000}_{args.index}_{safe}')
            open(dest_path, 'wb').write(content)
            print(json.dumps({'path': dest_path, 'name': fname, 'size': len(content)}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-reply':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body required'}))
            return
        try:
            from email.mime.text import MIMEText
            from email.utils import parseaddr
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            orig = _imap_fetch_msg(imap, uid_str)
            imap.logout()
            orig_subj = _decode_hdr(orig.get('Subject', ''))
            reply_subj = orig_subj if orig_subj.lower().startswith('re:') else f'Re: {orig_subj}'
            _, to_addr = parseaddr(_decode_hdr(orig.get('From', '')))
            msg_id = orig.get('Message-ID', '')
            reply = MIMEText(args.body, 'plain', 'utf-8')
            reply['Subject'] = reply_subj
            reply['From'] = cfg['email']
            reply['To'] = to_addr
            if msg_id:
                reply['In-Reply-To'] = msg_id
                reply['References'] = msg_id
            smtp = _smtp_connect(cfg)
            smtp.send_message(reply)
            smtp.quit()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'flag':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            imap.uid('store', uid_str.encode(), '+FLAGS' if args.flagged else '-FLAGS', '(\\Flagged)')
            imap.logout()
            print(json.dumps({'ok': True, 'flagged': bool(args.flagged)}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'mark-unread':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            imap.uid('store', uid_str.encode(), '-FLAGS', '(\\Seen)')
            imap.logout()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'delete':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            imap.uid('store', uid_str.encode(), '+FLAGS', '(\\Deleted)')
            imap.expunge()
            imap.logout()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'forward':
        if not args.id or not args.to:
            print(json.dumps({'error': 'entryId and to required'}))
            return
        try:
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            from email.mime.base import MIMEBase
            from email import encoders as enc_mod
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            orig = _imap_fetch_msg(imap, uid_str)
            imap.logout()
            orig_subj = _decode_hdr(orig.get('Subject', ''))
            fwd_subj = orig_subj if orig_subj.lower().startswith('fwd:') else f'Fwd: {orig_subj}'
            fwd = MIMEMultipart()
            fwd['Subject'] = fwd_subj
            fwd['From'] = cfg['email']
            fwd['To'] = args.to
            plain, _ = _imap_body(orig)
            intro = (args.body + '\n\n') if args.body else ''
            fwd.attach(MIMEText(f'{intro}--- Forwarded message ---\n{plain}', 'plain', 'utf-8'))
            for part in orig.walk():
                fname = part.get_filename()
                if fname:
                    fname = _decode_hdr(fname)
                    content = part.get_payload(decode=True) or b''
                    att = MIMEBase('application', 'octet-stream')
                    att.set_payload(content)
                    enc_mod.encode_base64(att)
                    att.add_header('Content-Disposition', 'attachment', filename=fname)
                    fwd.attach(att)
            smtp = _smtp_connect(cfg)
            smtp.send_message(fwd)
            smtp.quit()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'open-in-outlook':
        print(json.dumps({'ok': False, 'error': 'Open in Outlook is not supported via IMAP'}))
        return

    if args.action == 'categorize':
        # IMAP doesn't support Outlook categories — silently acknowledge
        print(json.dumps({'ok': True, 'category': args.category}))
        return

    if args.action == 'suggest-attachments':
        query = args.query.strip()
        if not query:
            print(json.dumps({'results': []}))
            return
        try:
            imap = _imap_connect(cfg)
            imap.select('INBOX', readonly=True)
            sf_match = re.search(r'SR00[A-Za-z0-9]+', query, re.IGNORECASE)
            sf_id = sf_match.group(0) if sf_match else ''
            words = [w for w in re.split(r'\W+', query) if len(w) > 3][:3]
            search_word = sf_id or (words[0] if words else '')
            if search_word:
                typ, uids_data = imap.uid('search', None, 'SUBJECT', f'"{search_word}"')
            else:
                typ, uids_data = imap.uid('search', None, 'ALL')
            uids = list(reversed(uids_data[0].split() if uids_data[0] else []))[:30]
            results = []
            for uid in uids:
                if len(results) >= 6:
                    break
                try:
                    msg = _imap_fetch_msg(imap, uid)
                    atts = _imap_att_list(msg)
                    pdf_atts = [a for a in atts if a['isPdf']]
                    if not pdf_atts:
                        continue
                    from email.utils import parseaddr
                    sender_name, _ = parseaddr(_decode_hdr(msg.get('From', '')))
                    subject = _decode_hdr(msg.get('Subject', '(no subject)'))
                    try:
                        from email.utils import parsedate_to_datetime
                        received = parsedate_to_datetime(msg.get('Date', '')).isoformat()
                    except Exception:
                        received = msg.get('Date', '')
                    uid_str = uid.decode() if isinstance(uid, bytes) else uid
                    for att in pdf_atts:
                        results.append({
                            'sourceEntryId':   f'imap:{uid_str}',
                            'attachmentIndex': att['index'],
                            'attachmentName':  att['name'],
                            'attachmentSize':  att['size'],
                            'emailSubject':    subject,
                            'sender':          sender_name,
                            'received':        received,
                            'score':           1,
                        })
                        if len(results) >= 6:
                            break
                except Exception:
                    continue
            imap.logout()
            print(json.dumps({'results': results}))
        except Exception as e:
            print(json.dumps({'results': [], 'error': str(e)}))
        return

    if args.action == 'reply-with-attachments':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body required'}))
            return
        try:
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            from email.mime.base import MIMEBase
            from email import encoders as enc_mod
            from email.utils import parseaddr
            uid_str = args.id.split(':', 1)[-1]
            imap = _imap_connect(cfg)
            imap.select('INBOX')
            orig = _imap_fetch_msg(imap, uid_str)
            orig_subj = _decode_hdr(orig.get('Subject', ''))
            reply_subj = orig_subj if orig_subj.lower().startswith('re:') else f'Re: {orig_subj}'
            _, to_addr = parseaddr(_decode_hdr(orig.get('From', '')))
            msg_id = orig.get('Message-ID', '')
            reply = MIMEMultipart()
            reply['Subject'] = reply_subj
            reply['From'] = cfg['email']
            reply['To'] = to_addr
            if msg_id:
                reply['In-Reply-To'] = msg_id
                reply['References'] = msg_id
            reply.attach(MIMEText(args.body, 'plain', 'utf-8'))
            att_sources = json.loads(args.att_sources or '[]')
            for src in att_sources:
                try:
                    src_uid = src.get('entryId', '').split(':', 1)[-1]
                    src_idx = src.get('index', 1)
                    src_msg = _imap_fetch_msg(imap, src_uid)
                    att_parts = [p for p in src_msg.walk() if not p.is_multipart() and p.get_filename()]
                    if src_idx <= len(att_parts):
                        part = att_parts[src_idx - 1]
                        fname = _decode_hdr(part.get_filename())
                        content = part.get_payload(decode=True) or b''
                        att = MIMEBase('application', 'octet-stream')
                        att.set_payload(content)
                        enc_mod.encode_base64(att)
                        att.add_header('Content-Disposition', 'attachment', filename=fname)
                        reply.attach(att)
                except Exception as ae:
                    sys.stderr.write(f'[WARN] attach: {ae}\n')
            imap.logout()
            smtp = _smtp_connect(cfg)
            smtp.send_message(reply)
            smtp.quit()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-new':
        if not args.to or not args.subject:
            print(json.dumps({'error': 'to and subject required'}))
            return
        try:
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            from email.mime.base import MIMEBase
            from email import encoders as enc_mod
            att_sources = json.loads(args.att_sources or '[]')
            if att_sources:
                msg_out = MIMEMultipart()
                msg_out.attach(MIMEText(args.body or '', 'plain', 'utf-8'))
            else:
                msg_out = MIMEText(args.body or '', 'plain', 'utf-8')
            msg_out['Subject'] = args.subject
            msg_out['From'] = cfg['email']
            msg_out['To'] = args.to
            if att_sources:
                imap = _imap_connect(cfg)
                imap.select('INBOX', readonly=True)
                for src in att_sources:
                    try:
                        src_uid = src.get('entryId', '').split(':', 1)[-1]
                        src_idx = src.get('index', 1)
                        src_msg = _imap_fetch_msg(imap, src_uid)
                        att_parts = [p for p in src_msg.walk() if not p.is_multipart() and p.get_filename()]
                        if src_idx <= len(att_parts):
                            part = att_parts[src_idx - 1]
                            fname = _decode_hdr(part.get_filename())
                            content = part.get_payload(decode=True) or b''
                            att = MIMEBase('application', 'octet-stream')
                            att.set_payload(content)
                            enc_mod.encode_base64(att)
                            att.add_header('Content-Disposition', 'attachment', filename=fname)
                            msg_out.attach(att)
                    except Exception as ae:
                        sys.stderr.write(f'[WARN] attach: {ae}\n')
                imap.logout()
            smtp = _smtp_connect(cfg)
            smtp.send_message(msg_out)
            smtp.quit()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return


# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--action', required=True, choices=[
        'status', 'mailboxes', 'emails', 'email', 'save-attachment',
        'send-reply', 'get-attachment',
        'flag', 'mark-unread', 'delete', 'forward', 'open-in-outlook',
        'categorize', 'suggest-attachments', 'reply-with-attachments', 'send-new',
        'graph-connect', 'imap-config',
        'current-selection', 'emails-from',
        'scan-quotes', 'scan-jobs', 'scan-crm-quotes', 'scan-todo', 'contacts',
    ])
    parser.add_argument('--backend',    default='auto', choices=['auto', 'graph', 'win32', 'imap'])
    parser.add_argument('--store',      default='default')
    parser.add_argument('--limit',      type=int, default=20)
    parser.add_argument('--unread',     type=int, default=0)
    parser.add_argument('--id',         default='')
    parser.add_argument('--dest',       default='')
    parser.add_argument('--index',      type=int, default=0)
    parser.add_argument('--body',       default='')
    parser.add_argument('--to',         default='')
    parser.add_argument('--subject',    default='')
    parser.add_argument('--category',   default='')
    parser.add_argument('--flagged',    type=int, default=1)
    parser.add_argument('--query',      default='')
    parser.add_argument('--att-sources', default='[]')
    parser.add_argument('--sender',     default='')   # substring to match sender addr/name
    parser.add_argument('--since',      default='')    # DD/MM/YYYY or MM/DD/YYYY start date
    parser.add_argument('--recipient',  default='')    # comma-sep substrings; keep only if ANY is a To/CC recipient
    parser.add_argument('--days',       type=int, default=30)  # scan-quotes look-back window
    parser.add_argument('--until',      default='')    # scan-jobs end date, DD/MM/YYYY
    parser.add_argument('--max',        type=int, default=5000) # scan-jobs message cap
    parser.add_argument('--store-filter', dest='store_filter', default='')  # scan-todo/contacts: mailbox name substring
    parser.add_argument('--draft',      type=int, default=0)    # send-new: leave in Drafts instead of sending
    args = parser.parse_args()

    # ── IMAP config: test + save credentials ─────────────────────────────────
    if args.action == 'imap-config':
        try:
            cfg_in     = json.loads(args.body)
            email_addr = cfg_in.get('email', '').strip()
            password   = cfg_in.get('password', '').strip()
            if not email_addr:
                print(json.dumps({'ok': False, 'error': 'Email is required'}))
                return
            if not password:
                print(json.dumps({'ok': False, 'error': 'App password is required'}))
                return
            import imaplib
            server = cfg_in.get('imapServer', 'outlook.office365.com')
            port   = int(cfg_in.get('imapPort', 993))
            imap_t = imaplib.IMAP4_SSL(server, port)
            imap_t.login(email_addr, password)
            imap_t.logout()
            save_cfg = {
                'email':       email_addr,
                'password':    password,
                'imap_server': server,
                'imap_port':   port,
                'smtp_server': cfg_in.get('smtpServer', 'smtp.office365.com'),
                'smtp_port':   int(cfg_in.get('smtpPort', 587)),
                'auth_type':   'basic',
            }
            json.dump(save_cfg, open(IMAP_CONFIG, 'w'))
            print(json.dumps({'ok': True, 'email': email_addr, 'authType': 'basic'}))
        except Exception as e:
            err = str(e)
            if any(k in err for k in ('AUTHENTICATIONFAILED', '535', 'Invalid credentials', 'AUTHENTICATE failed', 'authentication failed')):
                err = 'Wrong password — make sure you copied the full app password without spaces.'
            print(json.dumps({'ok': False, 'error': err}))
        return

    # ── Graph connect (interactive browser auth) ──────────────────────────────
    if args.action == 'graph-connect':
        try:
            import msal  # noqa
            app, cache = _gapp()
            result = app.acquire_token_interactive(GRAPH_SCOPES)
            if 'access_token' in result:
                _save_gcache(cache)
                user = _gget(result['access_token'], '/me',
                             params={'$select': 'displayName,mail'})
                print(json.dumps({
                    'ok':    True,
                    'name':  user.get('displayName', ''),
                    'email': user.get('mail', ''),
                }))
            else:
                err = result.get('error_description') or result.get('error', 'Authentication failed')
                print(json.dumps({'ok': False, 'error': err}))
        except Exception as e:
            print(json.dumps({'ok': False, 'error': str(e)}))
        return

    # ── Status ────────────────────────────────────────────────────────────────
    if args.action == 'status':
        try:
            import pythoncom  # noqa
            import win32com.client  # noqa
        except ImportError:
            print(json.dumps({'available': False,
                              'error': 'pywin32 not installed. Run: pip install pywin32'}))
            return

        try:
            _, ns = get_outlook_ns()
            ns.GetDefaultFolder(6)
            print(json.dumps({'available': True, 'backend': 'win32'}))
        except Exception as e:
            print(json.dumps({'available': False, 'error': str(e)}))
        return

    # ── Route remaining actions → win32 ──────────────────────────────────────
    if True:
        try:
            import pythoncom  # noqa
            import win32com.client  # noqa
        except ImportError:
            print(json.dumps({'error': 'pywin32 not installed. Run: pip install pywin32',
                              'available': False}))
            return
        _win32_action(args)


# ─── win32com action dispatcher ───────────────────────────────────────────────
def _win32_action(args):

    if args.action == 'current-selection':
        # Reads whatever email the user has highlighted in Outlook's
        # ActiveExplorer. Used by the floating overlay companion app to poll
        # the current selection ~every 2s.
        try:
            outlook, _ns = get_outlook_ns()
            explorer = outlook.ActiveExplorer()
            if not explorer:
                print(json.dumps({'selected': False, 'reason': 'no Active Explorer window'}))
                return
            sel = explorer.Selection
            if not sel or sel.Count == 0:
                print(json.dumps({'selected': False, 'reason': 'no email selected'}))
                return
            item = sel.Item(1)
            # Class 43 = MailItem
            if getattr(item, 'Class', None) != 43:
                print(json.dumps({'selected': False, 'reason': 'selected item is not a mail item'}))
                return
            atts = [att_info(item.Attachments.Item(k))
                    for k in range(1, item.Attachments.Count + 1)]
            print(json.dumps({
                'selected':    True,
                'entryId':     item.EntryID,
                'subject':     item.Subject or '(no subject)',
                'sender':      item.SenderName or '',
                'senderEmail': resolve_smtp(item),
                'received':    str(item.ReceivedTime),
                'body':        (item.Body or '')[:6000],
                'unread':      bool(item.UnRead),
                'attachments': atts,
                'hasPdf':      any(a['isPdf'] for a in atts),
            }))
        except Exception as e:
            print(json.dumps({'selected': False, 'error': str(e)}))
        return

    if args.action == 'mailboxes':
        try:
            _, ns = get_outlook_ns()
            try:
                personal_store_id = ns.GetDefaultFolder(6).StoreID
            except Exception:
                personal_store_id = None
            mailboxes = []
            for i in range(1, ns.Stores.Count + 1):
                store = ns.Stores.Item(i)
                try:
                    root  = store.GetRootFolder()
                    inbox = find_inbox(root)
                    if not inbox:
                        continue
                    mtype = 'personal' if (personal_store_id and store.StoreID == personal_store_id) else 'shared'
                    mailboxes.append({'storeId': store.StoreID, 'name': store.DisplayName,
                                      'type': mtype, 'inboxName': inbox.Name})
                except Exception:
                    pass
            print(json.dumps({'mailboxes': mailboxes}))
        except Exception as e:
            print(json.dumps({'mailboxes': [], 'error': str(e)}))
        return

    if args.action == 'emails':
        try:
            _, ns = get_outlook_ns()
            if args.store == 'default':
                folder = ns.GetDefaultFolder(6)
            else:
                folder = None
                for i in range(1, ns.Stores.Count + 1):
                    store = ns.Stores.Item(i)
                    if store.StoreID == args.store:
                        folder = find_inbox(store.GetRootFolder())
                        break
                if not folder:
                    print(json.dumps({'emails': [], 'error': 'Mailbox not found'}))
                    return
            items = folder.Items
            items.Sort('[ReceivedTime]', True)
            emails = []
            count  = 0
            for item in items:
                if count >= args.limit:
                    break
                try:
                    if item.Class != 43:
                        continue
                    if args.unread and not item.UnRead:
                        continue
                    s = email_summary(item)
                    if s:
                        emails.append(s)
                        count += 1
                except Exception:
                    pass
            print(json.dumps({'emails': emails}))
        except Exception as e:
            print(json.dumps({'emails': [], 'error': str(e)}))
        return

    # ── Fetch every Inbox email from a given sender since a date, with body +
    #    attachments (used by the EL Internal Info tab). ─────────────────────────
    if args.action == 'emails-from':
        def _recipients_blob(item):
            parts = [getattr(item, 'To', '') or '', getattr(item, 'CC', '') or '']
            try:
                for i in range(1, item.Recipients.Count + 1):
                    r = item.Recipients.Item(i)
                    try:
                        ae = r.AddressEntry
                        try:
                            parts.append(ae.GetExchangeUser().PrimarySmtpAddress or '')
                        except Exception:
                            parts.append(getattr(ae, 'Address', '') or '')
                    except Exception:
                        parts.append(getattr(r, 'Address', '') or getattr(r, 'Name', '') or '')
            except Exception:
                pass
            return ' '.join(parts).lower()
        try:
            _, ns = get_outlook_ns()
            folder = ns.GetDefaultFolder(6)  # Inbox
            items  = folder.Items
            items.Sort('[ReceivedTime]', True)
            if args.since:
                try:
                    items = items.Restrict(f"[ReceivedTime] >= '{args.since} 00:00'")
                except Exception:
                    pass
            needle = (args.sender or '').strip().lower()
            recip_needles = [s.strip().lower() for s in (args.recipient or '').split(',') if s.strip()]
            emails = []
            for item in items:
                try:
                    if item.Class != 43:
                        continue
                    addr  = (getattr(item, 'SenderEmailAddress', '') or '')
                    name  = (getattr(item, 'SenderName', '') or '')
                    smtp  = resolve_smtp(item)
                    blob  = f'{addr} {name} {smtp}'.lower()
                    if needle and needle not in blob:
                        continue
                    if recip_needles:
                        rblob = _recipients_blob(item)
                        if not any(n in rblob for n in recip_needles):
                            continue
                    atts = [att_info(item.Attachments.Item(k))
                            for k in range(1, item.Attachments.Count + 1)]
                    emails.append({
                        'entryId':     item.EntryID,
                        'subject':     item.Subject or '(no subject)',
                        'sender':      name,
                        'senderEmail': smtp,
                        'received':    str(item.ReceivedTime),
                        'body':        (item.Body or '')[:6000],
                        'attachments': atts,
                        'hasPdf':      any(a['isPdf'] for a in atts),
                    })
                except Exception:
                    pass
            print(json.dumps({'emails': emails}))
        except Exception as e:
            print(json.dumps({'emails': [], 'error': str(e)}))
        return

    # ── Quick check-up: quote mail sitting in the Inbox tree that may never have
    #    been pushed to the Quotations List. This only REPORTS what it found and
    #    which references it carries — deciding what is already uploaded is the
    #    server's job (it checks SharePoint live). ───────────────────────────────
    if args.action == 'scan-quotes':
        try:
            _, ns = get_outlook_ns()

            # Quote mail does NOT arrive in the personal mailbox — it lands in the
            # shared quote-factory mailbox. So scan the Inbox tree of EVERY work
            # store, not just ns.GetDefaultFolder(6).
            roots = []
            if args.store and args.store != 'default':
                for i in range(1, ns.Stores.Count + 1):
                    store = ns.Stores.Item(i)
                    if store.StoreID == args.store:
                        inbox = find_inbox(store.GetRootFolder())
                        if inbox:
                            roots.append(inbox)
                        break
                if not roots:
                    print(json.dumps({'quotes': [], 'error': 'Mailbox not found'}))
                    return
            else:
                for _name, root in work_stores(ns):
                    inbox = find_inbox(root)
                    if inbox:
                        roots.append(inbox)
                if not roots:
                    try:
                        roots = [ns.GetDefaultFolder(6)]
                    except Exception:
                        print(json.dumps({'quotes': [], 'error': 'No mailbox available'}))
                        return

            days   = max(1, int(args.days or 30))
            cutoff = datetime.date.today() - datetime.timedelta(days=days)
            since  = cutoff.strftime('%m/%d/%Y')
            cut_t  = (cutoff.year, cutoff.month, cutoff.day)

            found, scanned = [], 0
            folders = []
            for root in roots:
                folders.extend(walk_folders(root))
            for folder in folders:
                fpath = folder_path(folder)
                try:
                    items = _restrict_since(folder.Items, since, with_attachment=True)
                except Exception:
                    continue
                for item in items:
                    try:
                        if getattr(item, 'Class', None) != 43:
                            continue
                        dt = _date_tuple(_item_date(item))
                        if dt and dt < cut_t:
                            continue
                        scanned += 1

                        # Cheapest gate first: no attachments at all → not a quote.
                        # Then read only FileName/Size. Deliberately NOT att_info()
                        # — its content-id lookup is a MAPI round-trip per
                        # attachment, and the extension filter below already rules
                        # out the inline images that flag would have caught.
                        try:
                            n_att = int(item.Attachments.Count)
                        except Exception:
                            n_att = 0
                        if not n_att:
                            continue
                        docs = []
                        for k in range(1, n_att + 1):
                            try:
                                a = item.Attachments.Item(k)
                                nm = a.FileName or ''
                                if nm.lower().endswith(QUOTE_DOC_EXTS):
                                    docs.append({'index': a.Index, 'name': nm, 'size': a.Size})
                            except Exception:
                                pass
                        if not docs:
                            continue

                        subject = item.Subject or ''
                        smtp    = resolve_smtp(item)
                        is_notif = 'manualnotification' in f'{smtp}'.lower()

                        # Subject + attachment names first (both cheap, and the
                        # BidManager number is usually in the filename). Only pay
                        # for the body if neither carried a reference.
                        hay  = subject + ' ' + ' '.join(d['name'] for d in docs)
                        refs = REF_RE.findall(hay)
                        bm   = find_bm_refs(hay)
                        if not refs and not bm:
                            body = (item.Body or '')[:4000]
                            refs = REF_RE.findall(body)
                            bm   = find_bm_refs(body)
                        if not refs and not bm and not is_notif:
                            continue

                        seen_r, uniq = set(), []
                        for r in refs:
                            n = normalize_ref(r)
                            if n not in seen_r:
                                seen_r.add(n)
                                uniq.append({'raw': r, 'norm': n})

                        found.append({
                            'entryId':     item.EntryID,
                            'subject':     subject or '(no subject)',
                            'sender':      getattr(item, 'SenderName', '') or '',
                            'senderEmail': smtp,
                            'received':    str(_item_date(item) or ''),
                            'folder':      fpath,
                            'isNotification': is_notif,
                            'refs':        uniq,
                            'bmRefs':      bm,
                            'docs':        docs,
                        })
                    except Exception:
                        pass
            found.sort(key=lambda e: e['received'], reverse=True)
            print(json.dumps({'quotes': found, 'scanned': scanned, 'days': days}))
        except Exception as e:
            print(json.dumps({'quotes': [], 'error': str(e)}))
        return

    # ── CRM mailbox index: every quote that can be seen from this desk, wherever
    #    it sits. Unlike scan-quotes (Inbox trees only, "what still needs
    #    uploading?") this sweeps EVERY folder of every store — the shared
    #    quote-factory mailbox and its "Completed by <person>" folders included —
    #    and returns one row per QUOTE rather than per message, split into the
    #    work this desk issued and the work the rest of the team issued.
    if args.action == 'scan-crm-quotes':
        try:
            _, ns = get_outlook_ns()

            me = ''
            try:
                me = ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress or ''
            except Exception:
                try:
                    me = ns.CurrentUser.Address or ''
                except Exception:
                    me = ''
            me_l = (me or '').lower()
            me_name = ''
            try:
                me_name = ns.CurrentUser.Name or ''
            except Exception:
                me_name = ''

            # Name tokens used to spot MY "Completed by <person>" folder among the
            # one-per-engineer set in the shared mailbox.
            my_tokens = {t for t in re.split(r'[^A-Za-z]+', f'{me_name} {me_l.split("@")[0]}'.lower())
                         if len(t) >= 3}

            # The personal mailbox is wherever the default Inbox lives — the most
            # reliable marker; store display names vary per profile.
            personal_store = ''
            try:
                personal_store = ns.GetDefaultFolder(6).Store.StoreID or ''
            except Exception:
                personal_store = ''

            days   = max(1, int(args.days or 90))
            cutoff = datetime.date.today() - datetime.timedelta(days=days)
            since  = '%02d/%02d/%04d' % (cutoff.month, cutoff.day, cutoff.year)
            cut_t  = (cutoff.year, cutoff.month, cutoff.day)

            stores = work_stores(ns)
            if not stores:
                print(json.dumps({'quotes': [], 'error': 'No mailbox available'}))
                return

            # Whose quote is this? Every message that carries the reference votes,
            # and the strongest signal wins for the quote as a whole (lowest
            # number below). Two things make this more than "who sent the mail":
            #   · sending the DOCUMENT is what issuing a quote means — merely
            #     replying in someone else's thread is a much weaker claim;
            #   · another engineer's "Completed by" folder outranks the fact that
            #     a copy also landed in this desk's personal inbox, which is the
            #     shared-mailbox case that fools a flat sender rule.
            #   1 you sent the document     5 you replied in the thread
            #   2 your completed folder     6 someone else in the thread
            #   3 someone else's folder     7 sits in your personal mailbox
            #   4 document came from them   8 nothing to go on
            def classify(fpath, store_id, sent_by_me, auto_sender, sender, smtp, has_docs):
                leaf = (fpath or '').split('\\')[-1]
                low  = leaf.lower()
                who  = sender or smtp or 'someone else'
                if sent_by_me and has_docs:
                    return 1, 'mine', 'you sent the quote document'
                if 'completed by' in low:
                    if any(t in low for t in my_tokens):
                        return 2, 'mine', 'filed in "%s"' % leaf
                    return 3, 'team', 'filed in "%s"' % leaf
                if has_docs and not auto_sender:
                    return 4, 'team', 'the document came from %s' % who
                if sent_by_me:
                    return 5, 'mine', 'you replied in this thread'
                if not auto_sender:
                    return 6, 'team', 'thread with %s' % who
                if personal_store and store_id == personal_store:
                    return 7, 'mine', 'no sender to go on — it is in your personal mailbox'
                return 8, 'team', 'no sender to go on — it sits in %s' % (fpath or 'a shared folder')

            # key -> aggregated quote row
            quotes  = {}
            scanned = 0
            bodies  = 0
            BODY_CAP = 400          # bound the expensive path

            for _sname, root in stores:
                try:
                    store_id = root.Store.StoreID or ''
                except Exception:
                    store_id = ''
                try:
                    store_name = root.Name or _sname
                except Exception:
                    store_name = _sname
                for folder in walk_folders(root):
                    fpath = folder_path(folder)
                    try:
                        leaf_is_sent = (folder.Name or '').lower() in SENT_NAMES
                    except Exception:
                        leaf_is_sent = False
                    try:
                        items = _restrict_since(folder.Items, since)
                    except Exception:
                        continue
                    hits = 0
                    for item in items:
                        try:
                            if getattr(item, 'Class', None) != 43:
                                continue
                            raw_dt = _item_date(item)
                            dt     = _date_tuple(raw_dt)
                            if dt and dt < cut_t:
                                continue
                            scanned += 1

                            subject = item.Subject or ''
                            # Subject is already loaded; attachment names cost one
                            # property read each, so try the subject first.
                            refs = REF_RE.findall(subject)
                            bm   = find_bm_refs(subject)

                            docs = []
                            try:
                                n_att = int(item.Attachments.Count)
                            except Exception:
                                n_att = 0
                            if n_att:
                                for k in range(1, n_att + 1):
                                    try:
                                        a  = item.Attachments.Item(k)
                                        nm = a.FileName or ''
                                        if nm.lower().endswith(QUOTE_DOC_EXTS):
                                            docs.append({'index': a.Index, 'name': nm, 'size': a.Size})
                                    except Exception:
                                        pass
                            if docs and not refs and not bm:
                                names = ' '.join(d['name'] for d in docs)
                                refs  = REF_RE.findall(names)
                                bm    = find_bm_refs(names)
                            # Last resort, and only for mail that actually carries a
                            # document: the reference is sometimes only in the body.
                            if docs and not refs and not bm and bodies < BODY_CAP:
                                bodies += 1
                                body = (item.Body or '')[:4000]
                                refs = REF_RE.findall(body)
                                bm   = find_bm_refs(body)
                            if not refs and not bm:
                                continue

                            smtp   = (resolve_smtp(item) or '')
                            smtp_l = smtp.lower()
                            sender = getattr(item, 'SenderName', '') or ''
                            # A quote mail with no human behind it: BidManager /
                            # manualnotification robots, or the shared mailbox
                            # sending as itself.
                            auto_sender = (not smtp_l
                                           or 'manualnotification' in smtp_l
                                           or 'bidmanager' in smtp_l
                                           or 'noreply' in smtp_l or 'no-reply' in smtp_l
                                           or 'donotreply' in smtp_l
                                           or 'quotefactory' in smtp_l)
                            sent_by_me = bool(me_l and smtp_l == me_l) or \
                                (leaf_is_sent and personal_store and store_id == personal_store)

                            prio, side, why = classify(fpath, store_id, sent_by_me,
                                                       auto_sender, sender, smtp, bool(docs))

                            when = str(raw_dt or '')
                            for kind, raw, key in (
                                [('sfid', r, normalize_ref(r)) for r in refs]
                                + [('bm', b['raw'], b['base']) for b in bm]
                            ):
                                if not key:
                                    continue
                                q = quotes.get(key)
                                if q is None:
                                    q = quotes[key] = {
                                        'key': key, 'kind': kind, 'ref': raw,
                                        'subject': subject or '(no subject)',
                                        'sender': sender, 'senderEmail': smtp,
                                        'to': (getattr(item, 'To', '') or '')[:200],
                                        'first': when, 'last': when,
                                        'entryId': item.EntryID, 'folder': fpath,
                                        'store': store_name, 'folders': [fpath],
                                        'docs': docs, 'msgs': 0,
                                        'side': side, 'why': why, 'sideFolder': fpath,
                                        '_prio': prio, '_rank': (bool(docs), when),
                                    }
                                q['msgs'] += 1
                                if fpath not in q['folders']:
                                    q['folders'].append(fpath)
                                if when and when < q['first']:
                                    q['first'] = when
                                if when > q['last']:
                                    q['last'] = when
                                # The message worth opening from the CRM is the most
                                # recent one that actually carries the document.
                                rank = (bool(docs), when)
                                if rank > q['_rank']:
                                    q['_rank'] = rank
                                    q.update({'entryId': item.EntryID, 'folder': fpath,
                                              'store': store_name,
                                              'subject': subject or q['subject'],
                                              'sender': sender, 'senderEmail': smtp,
                                              'docs': docs or q['docs']})
                                # Keep the folder the verdict came from: the row's
                                # own folder is the newest message, which may not
                                # be the one that decided ownership.
                                if prio < q['_prio']:
                                    q['_prio'], q['side'], q['why'] = prio, side, why
                                    q['sideFolder'] = fpath
                            hits += 1
                        except Exception:
                            pass
                    if hits:
                        sys.stderr.write(f'[scan-crm-quotes] {fpath}: {hits}\n')

            rows = sorted(quotes.values(), key=lambda q: q['last'], reverse=True)
            for q in rows:
                q.pop('_rank', None)
                q.pop('_prio', None)
            print(json.dumps({
                'quotes': rows, 'scanned': scanned, 'days': days,
                'me': me, 'meName': me_name,
                'stores': [n for n, _r in stores],
            }))
        except Exception as e:
            print(json.dumps({'quotes': [], 'error': str(e)}))
        return

    # ── Job report: every mail folder in the mailbox (including hand-made ones
    #    like "Completed by Laith") over a date range. Bodies are read once per
    #    conversation, not once per message — that is what keeps a 3-month sweep
    #    of a busy mailbox to seconds rather than minutes. ──────────────────────
    if args.action == 'scan-jobs':
        try:
            _, ns = get_outlook_ns()

            me = ''
            try:
                me = ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress or ''
            except Exception:
                try:
                    me = ns.CurrentUser.Address or ''
                except Exception:
                    me = ''
            me_l = me.lower()
            # Display name too: the shared quote-factory mailbox has one
            # "Completed by <person>" folder per engineer, so the report has to
            # know which one is the current user's.
            me_name = ''
            try:
                me_name = ns.CurrentUser.Name or ''
            except Exception:
                me_name = ''

            since_t = _parse_ddmmyyyy(args.since)
            until_t = _parse_ddmmyyyy(args.until)
            if not since_t:
                print(json.dumps({'messages': [], 'error': '--since is required (DD/MM/YYYY)'}))
                return
            since_us = '%02d/%02d/%04d' % (since_t[1], since_t[2], since_t[0])
            until_us = '%02d/%02d/%04d' % (until_t[1], until_t[2], until_t[0]) if until_t else ''

            # Roots: every work store's mailbox root, so folders made at the top
            # level — "Completed by Laith" is a SIBLING of Inbox in the shared
            # quote-factory mailbox, not a child of it — are covered too.
            stores = work_stores(ns)
            roots  = [root for _name, root in stores]
            if not roots:
                try:
                    roots = [ns.GetDefaultFolder(6).Parent]
                except Exception:
                    print(json.dumps({'messages': [], 'error': 'No mailbox available'}))
                    return

            cap         = max(100, int(args.max or 5000))
            msgs        = []
            # conv -> [is_auto, body]. A human-written body always beats an
            # auto-reply as the sample the classifier reads.
            samples     = {}
            folders_hit = []
            truncated   = False

            for root in roots:
                for folder in walk_folders(root):
                    if truncated:
                        break
                    fpath = folder_path(folder)
                    try:
                        leaf_is_sent = (folder.Name or '').lower() in SENT_NAMES
                    except Exception:
                        leaf_is_sent = False
                    try:
                        items = _restrict_since(folder.Items, since_us, until_us)
                    except Exception:
                        continue
                    hits = 0
                    for item in items:
                        if len(msgs) >= cap:
                            truncated = True
                            break
                        try:
                            if getattr(item, 'Class', None) != 43:
                                continue
                            raw_dt = _item_date(item)
                            dt     = _date_tuple(raw_dt)
                            if dt and (dt < since_t or (until_t and dt > until_t)):
                                continue

                            smtp = resolve_smtp(item)
                            try:
                                conv = item.ConversationID or ''
                            except Exception:
                                conv = ''
                            try:
                                topic = item.ConversationTopic or ''
                            except Exception:
                                topic = ''
                            subject = item.Subject or ''
                            if not conv:
                                # No conversation id (rare — imported//converted
                                # items). Fall back to the normalised topic so the
                                # thread still groups instead of splintering.
                                conv = 'topic:' + re.sub(r'^\s*(re|fw|fwd|tr|aw|wg)\s*:\s*', '',
                                                         (topic or subject).lower()).strip()[:120]

                            # Anything sitting in a Sent Items folder was sent from
                            # this desk — in the SHARED mailbox the From address is
                            # the mailbox itself, not the person, so the address
                            # check alone would score every reply as "received".
                            sent_by_me = leaf_is_sent or bool(me_l and smtp and smtp.lower() == me_l)

                            auto = is_auto_message(item, subject, smtp)
                            # Read the body only when it can still improve the
                            # sample — that keeps this to ~one body read per
                            # conversation instead of one per message.
                            cur = samples.get(conv)
                            if cur is None or (cur[0] and not auto):
                                samples[conv] = [auto, (item.Body or '')[:600]]

                            n_atts = 0
                            try:
                                n_atts = int(item.Attachments.Count)
                            except Exception:
                                pass

                            msgs.append({
                                'entryId':     item.EntryID,
                                'conv':        conv,
                                'topic':       topic or subject,
                                'subject':     subject or '(no subject)',
                                'sender':      getattr(item, 'SenderName', '') or '',
                                'senderEmail': smtp,
                                'to':          (getattr(item, 'To', '') or '')[:300],
                                'date':        str(raw_dt or ''),
                                'folder':      fpath,
                                'direction':   'sent' if sent_by_me else 'received',
                                'atts':        n_atts,
                                'auto':        auto,
                            })
                            hits += 1
                        except Exception:
                            pass
                    if hits:
                        folders_hit.append({'folder': fpath, 'count': hits})
                    sys.stderr.write(f'[scan-jobs] {fpath}: {hits}\n')

            print(json.dumps({
                'messages':  msgs,
                'samples':   {k: v[1] for k, v in samples.items()},
                'me':        me,
                'meName':    me_name,
                'folders':   folders_hit,
                'stores':    [n for n, _r in stores],
                'truncated': truncated,
            }))
        except Exception as e:
            print(json.dumps({'messages': [], 'error': str(e)}))
        return

    # ── scan-todo: every UNANSWERED conversation in one mailbox ──────────────
    # Feeds the To-Do tab. Deliberately scoped to a SINGLE store (the shared
    # UKQuoteFactoryEL box) via --store-filter: the personal inbox is out of
    # scope, and sweeping it would bury the real queue under private mail.
    #
    # "Unanswered" = the newest human message in the thread was RECEIVED, i.e.
    # nobody at this desk has replied after it, and the thread is not filed in a
    # Completed-style folder. In a shared box a colleague's reply counts as
    # answered — the box owes nothing either way.
    if args.action == 'scan-todo':
        try:
            _, ns = get_outlook_ns()

            since_t = _parse_ddmmyyyy(args.since)
            if not since_t:
                print(json.dumps({'threads': [], 'error': '--since is required (DD/MM/YYYY)'}))
                return
            since_us = '%02d/%02d/%04d' % (since_t[1], since_t[2], since_t[0])

            me = ''
            try:
                me = ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress or ''
            except Exception:
                try:
                    me = ns.CurrentUser.Address or ''
                except Exception:
                    me = ''
            me_l = (me or '').lower()

            # Pick the target store. No match is an error, not an empty result:
            # silently scanning nothing would look like "inbox all clear".
            want   = (args.store_filter or 'quotefactory').strip().lower()
            stores = work_stores(ns)
            roots  = [root for name, root in stores if want in (name or '').lower()]
            if not roots:
                print(json.dumps({
                    'threads': [],
                    'error': f'No mailbox matching {want!r}. Available: '
                             + ', '.join(n for n, _r in stores),
                    'stores': [n for n, _r in stores],
                }))
                return

            cap       = max(100, int(args.max or 5000))
            seen      = 0
            truncated = False
            # conv -> aggregate. `last_recv` is the message a to-do would be about.
            convs     = {}

            for root in roots:
                for folder in walk_folders(root):
                    if truncated:
                        break
                    fpath = folder_path(folder)
                    leaf  = (getattr(folder, 'Name', '') or '').lower()
                    is_sent      = leaf in SENT_NAMES
                    is_completed = bool(re.match(r'^(completed|done|finished)\b', leaf))
                    try:
                        items = _restrict_since(folder.Items, since_us)
                    except Exception:
                        continue
                    for item in items:
                        if seen >= cap:
                            truncated = True
                            break
                        try:
                            if getattr(item, 'Class', None) != 43:
                                continue
                            raw_dt = _item_date(item)
                            dt     = _date_tuple(raw_dt)
                            if dt and dt < since_t:
                                continue
                            seen += 1

                            subject = item.Subject or ''
                            smtp    = resolve_smtp(item) or ''
                            if is_auto_message(item, subject, smtp):
                                continue          # bounces are not work owed

                            try:
                                conv = item.ConversationID or ''
                            except Exception:
                                conv = ''
                            try:
                                topic = item.ConversationTopic or ''
                            except Exception:
                                topic = ''
                            if not conv:
                                conv = 'topic:' + re.sub(r'^\s*(re|fw|fwd|tr|aw|wg)\s*:\s*', '',
                                                         (topic or subject).lower()).strip()[:120]

                            # A message sitting in Sent Items left this desk even
                            # though a shared mailbox stamps the box's own address
                            # on it, so the folder wins over the From address.
                            sent_here = is_sent or bool(me_l and smtp.lower() == me_l)
                            when      = str(raw_dt or '')

                            c = convs.get(conv)
                            if c is None:
                                c = convs[conv] = {
                                    'conv': conv, 'topic': topic or subject,
                                    'msgs': 0, 'sent': 0, 'received': 0,
                                    'first': when, 'last': when,
                                    'completed': False, 'folders': set(),
                                    'last_recv': None, 'last_any': when,
                                }
                            c['msgs'] += 1
                            if fpath:
                                c['folders'].add(fpath)
                            if is_completed:
                                c['completed'] = True
                            if when and when < c['first']:
                                c['first'] = when
                            if when and when > c['last']:
                                c['last'] = when
                            if sent_here:
                                c['sent'] += 1
                            else:
                                c['received'] += 1
                                prev = c['last_recv']
                                if prev is None or when > prev['date']:
                                    c['last_recv'] = {
                                        'entryId': item.EntryID,
                                        'subject': subject or '(no subject)',
                                        'sender':  getattr(item, 'SenderName', '') or '',
                                        'senderEmail': smtp,
                                        'to':      (getattr(item, 'To', '') or '')[:400],
                                        'date':    when,
                                        'folder':  fpath,
                                    }
                            # Newest message of ANY direction decides "answered".
                            if when and when > c['last_any']:
                                c['last_any'] = when
                            if when and when >= c['last_any']:
                                c['last_dir'] = 'sent' if sent_here else 'received'
                        except Exception:
                            pass
                    sys.stderr.write(f'[scan-todo] {fpath}\n')

            # Keep only threads still owing a reply, newest first.
            open_threads = [
                c for c in convs.values()
                if c['last_recv'] and not c['completed'] and c.get('last_dir') == 'received'
            ]
            open_threads.sort(key=lambda c: c['last_recv']['date'], reverse=True)

            out = []
            for c in open_threads[:200]:
                lr   = c['last_recv']
                body = ''
                atts = []
                try:
                    msg = ns.GetItemFromID(lr['entryId'])
                    body = (msg.Body or '')[:4000]
                    for k in range(1, msg.Attachments.Count + 1):
                        try:
                            a = att_info(msg.Attachments.Item(k))
                            if not a['isInline']:
                                atts.append({'index': a['index'], 'name': a['name'], 'size': a['size']})
                        except Exception:
                            pass
                except Exception:
                    pass
                out.append({
                    'conv':        c['conv'],
                    'topic':       c['topic'],
                    'entryId':     lr['entryId'],
                    'subject':     lr['subject'],
                    'sender':      lr['sender'],
                    'senderEmail': lr['senderEmail'],
                    'to':          lr['to'],
                    'received':    lr['date'],
                    'folder':      lr['folder'],
                    'msgs':        c['msgs'],
                    'sentCount':   c['sent'],
                    'recvCount':   c['received'],
                    'firstDate':   c['first'],
                    'lastDate':    c['last'],
                    'attachments': atts,
                    'body':        body,
                })

            print(json.dumps({
                'threads':   out,
                'me':        me,
                'scanned':   seen,
                'stores':    [n for n, _r in stores],
                'store':     [n for n, _r in stores if want in (n or '').lower()],
                'truncated': truncated,
            }))
        except Exception as e:
            print(json.dumps({'threads': [], 'error': str(e)}))
        return

    # ── contacts: who this desk actually corresponds with ────────────────────
    # Builds the To-Do recipient picker from real mail history rather than the
    # address book: ranked by how often you exchange mail with each address.
    if args.action == 'contacts':
        try:
            _, ns = get_outlook_ns()

            since_t = _parse_ddmmyyyy(args.since)
            if not since_t:
                # Default: the last year of correspondence.
                today   = datetime.date.today()
                since_t = (today.year - 1, today.month, today.day)
            since_us = '%02d/%02d/%04d' % (since_t[1], since_t[2], since_t[0])

            me = ''
            try:
                me = ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress or ''
            except Exception:
                me = ''
            me_l = (me or '').lower()

            want   = (args.store_filter or '').strip().lower()
            stores = work_stores(ns)
            roots  = [root for name, root in stores
                      if not want or want in (name or '').lower()]

            cap    = max(200, int(args.max or 4000))
            seen   = 0
            people = {}     # email -> {name, count, lastSeen, sent, received}

            def bump(addr, name, when, direction):
                addr = (addr or '').strip()
                if not addr or '@' not in addr:
                    return
                low = addr.lower()
                # Never offer yourself, the shared box, or a robot as a recipient.
                # The bulk-sender list is what actually shows up in this mailbox:
                # BigMachines/CPQ approvals, IT and HR broadcasts, training alerts.
                if low == me_l or re.search(r'no-?reply|do-?not-?reply|postmaster|'
                                            r'mailer-daemon|autoreply|manualnotification|'
                                            r'bidmanager|bigmachines|mobileapproval|'
                                            r'alerts?@|notification|newsletter|survey|'
                                            r'itservices@|masterdata', low):
                    return
                name = (name or '').strip().strip('\'"')
                p = people.get(low)
                if p is None:
                    p = people[low] = {'email': addr, 'name': name or '', 'count': 0,
                                       'lastSeen': '', 'sent': 0, 'received': 0}
                p['count'] += 1
                p[direction] += 1
                if name and (not p['name'] or len(name) > len(p['name'])):
                    p['name'] = name
                if when > p['lastSeen']:
                    p['lastSeen'] = when

            for root in roots:
                for folder in walk_folders(root):
                    if seen >= cap:
                        break
                    leaf    = (getattr(folder, 'Name', '') or '').lower()
                    is_sent = leaf in SENT_NAMES
                    try:
                        items = _restrict_since(folder.Items, since_us)
                    except Exception:
                        continue
                    for item in items:
                        if seen >= cap:
                            break
                        try:
                            if getattr(item, 'Class', None) != 43:
                                continue
                            seen += 1
                            when = str(_item_date(item) or '')
                            if is_sent:
                                # Who I write to is the strongest signal of who I
                                # would delegate to — read the recipient list.
                                try:
                                    n = min(int(item.Recipients.Count), 12)
                                except Exception:
                                    n = 0
                                for k in range(1, n + 1):
                                    try:
                                        r    = item.Recipients.Item(k)
                                        addr = getattr(r, 'Address', '') or ''
                                        if addr.upper().startswith('/O=') or addr.upper().startswith('EX:'):
                                            hit = _SMTP_CACHE.get(addr)
                                            if hit is None:
                                                try:
                                                    ex  = r.AddressEntry.GetExchangeUser()
                                                    hit = (ex.PrimarySmtpAddress if ex else '') or ''
                                                except Exception:
                                                    hit = ''
                                                _SMTP_CACHE[addr] = hit
                                            addr = hit
                                        bump(addr, getattr(r, 'Name', '') or '', when, 'sent')
                                    except Exception:
                                        pass
                            else:
                                subject = item.Subject or ''
                                smtp    = resolve_smtp(item) or ''
                                if is_auto_message(item, subject, smtp):
                                    continue
                                bump(smtp, getattr(item, 'SenderName', '') or '', when, 'received')
                        except Exception:
                            pass

            ranked = sorted(people.values(), key=lambda p: (-p['count'], p['email']))[:400]
            print(json.dumps({'contacts': ranked, 'scanned': seen, 'me': me}))
        except Exception as e:
            print(json.dumps({'contacts': [], 'error': str(e)}))
        return

    if args.action == 'email':
        if not args.id:
            print(json.dumps({'error': 'No entry ID provided'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            atts  = [att_info(item.Attachments.Item(k))
                     for k in range(1, item.Attachments.Count + 1)]
            try:
                item.UnRead = False
                item.Save()
            except Exception:
                pass
            print(json.dumps({
                'entryId':     item.EntryID,
                'subject':     item.Subject or '(no subject)',
                'sender':      item.SenderName or '',
                'senderEmail': resolve_smtp(item),
                'to':          item.To or '',
                'cc':          item.CC or '',
                'received':    str(item.ReceivedTime),
                'body':        (item.Body or '')[:6000],
                'htmlBody':    item.HTMLBody or '',
                'unread':      bool(item.UnRead),
                'attachments': atts,
                'hasPdf':      any(a['isPdf'] for a in atts),
                'flagged':     int(getattr(item, 'FlagStatus', 0)) == 2,
                'categories':  getattr(item, 'Categories', '') or '',
            }))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'save-attachment':
        if not args.id or not args.dest:
            print(json.dumps({'error': 'entryId and dest are required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            os.makedirs(args.dest, exist_ok=True)
            saved = []
            for k in range(1, item.Attachments.Count + 1):
                att = item.Attachments.Item(k)
                if att.FileName.lower().endswith('.pdf'):
                    dest_path = os.path.join(args.dest, att.FileName)
                    att.SaveAsFile(dest_path)
                    saved.append({'name': att.FileName, 'path': dest_path})
            try:
                item.UnRead = False
                item.Save()
            except Exception:
                pass
            print(json.dumps({'saved': saved, 'count': len(saved)}))
        except Exception as e:
            print(json.dumps({'error': str(e), 'saved': []}))
        return

    if args.action == 'get-attachment':
        if not args.id or not args.dest or not args.index:
            print(json.dumps({'error': 'entryId, dest and index are required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            os.makedirs(args.dest, exist_ok=True)
            att   = item.Attachments.Item(args.index)
            safe  = att.FileName.replace('/', '_').replace('\\', '_')
            dest_path = os.path.join(args.dest, f'att_{abs(hash(args.id)) % 100000}_{args.index}_{safe}')
            att.SaveAsFile(dest_path)
            print(json.dumps({'path': dest_path, 'name': att.FileName, 'size': att.Size}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-reply':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body are required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            reply = item.Reply()
            reply.Body = args.body + '\n\n' + (reply.Body or '')
            reply.Send()
            print(json.dumps({'ok': True, 'to': item.SenderEmailAddress}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'flag':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            item.FlagStatus = 2 if args.flagged else 0
            item.Save()
            print(json.dumps({'ok': True, 'flagged': bool(args.flagged)}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'mark-unread':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            item.UnRead = True
            item.Save()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'delete':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            item.Delete()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'forward':
        if not args.id or not args.to:
            print(json.dumps({'error': 'entryId and to are required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            fwd   = item.Forward()
            fwd.To = args.to
            if args.body:
                fwd.Body = args.body + '\n\n' + (fwd.Body or '')
            fwd.Send()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'open-in-outlook':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            item.Display()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'categorize':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _, ns = get_outlook_ns()
            item  = ns.GetItemFromID(args.id)
            item.Categories = args.category
            item.Save()
            print(json.dumps({'ok': True, 'category': args.category}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'suggest-attachments':
        query = args.query.strip()
        if not query:
            print(json.dumps({'results': []}))
            return
        try:
            _, ns = get_outlook_ns()
            sf_match = re.search(r'SR00[A-Za-z0-9]+', query, re.IGNORECASE)
            sf_id    = sf_match.group(0) if sf_match else ''
            qn_words = [w.lower() for w in re.split(r'\W+', query) if len(w) > 3]

            results  = []
            seen_ids = set()
            folders  = _folders_for_att_search(ns)
            min_score = 1

            for folder in folders:
                try:
                    items = folder.Items
                    items.Sort('[ReceivedTime]', True)
                    scanned = 0
                    for item in items:
                        if scanned >= 600 or len(results) >= 12:
                            break
                        try:
                            if item.Class != 43:
                                continue
                            scanned += 1
                            if not item.Attachments.Count:
                                continue
                            entry_id = item.EntryID
                            if entry_id in seen_ids:
                                continue
                            seen_ids.add(entry_id)

                            subject = item.Subject or ''
                            body    = (item.Body or '')[:2000]
                            score   = _score(subject, body, sf_id, qn_words)
                            if score < min_score:
                                continue

                            for k in range(1, item.Attachments.Count + 1):
                                try:
                                    att = item.Attachments.Item(k)
                                    if not att.FileName.lower().endswith('.pdf'):
                                        continue
                                    results.append({
                                        'sourceEntryId':   entry_id,
                                        'attachmentIndex': k,
                                        'attachmentName':  att.FileName,
                                        'attachmentSize':  att.Size,
                                        'emailSubject':    subject or '(no subject)',
                                        'sender':          item.SenderName or '',
                                        'received':        str(item.ReceivedTime),
                                        'score':           score,
                                    })
                                except Exception:
                                    pass
                        except Exception:
                            continue
                except Exception:
                    continue

            results.sort(key=lambda x: -x['score'])
            print(json.dumps({'results': results[:6]}))
        except Exception as e:
            print(json.dumps({'results': [], 'error': str(e)}))
        return

    if args.action == 'reply-with-attachments':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body are required'}))
            return
        try:
            _, ns   = get_outlook_ns()
            item    = ns.GetItemFromID(args.id)
            reply   = item.Reply()
            reply.Body = args.body + '\n\n' + (reply.Body or '')

            att_sources = json.loads(args.att_sources or '[]')
            tmp_dir = tempfile.mkdtemp(prefix='vector_att_')
            for src in att_sources:
                try:
                    src_item = ns.GetItemFromID(src['entryId'])
                    att      = src_item.Attachments.Item(src['index'])
                    safe     = att.FileName.replace('/', '_').replace('\\', '_')
                    tmp_path = os.path.join(tmp_dir, safe)
                    att.SaveAsFile(tmp_path)
                    reply.Attachments.Add(tmp_path)
                except Exception as ae:
                    print(f'[WARN] Could not attach {src}: {ae}', file=sys.stderr)

            reply.Send()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-new':
        if not args.to or not args.subject:
            print(json.dumps({'error': 'to and subject are required'}))
            return
        try:
            app_ol, ns = get_outlook_ns()
            mail = app_ol.CreateItem(0)
            mail.To      = args.to
            mail.Subject = args.subject
            mail.Body    = args.body or ''

            att_sources = json.loads(args.att_sources or '[]')
            tmp_dir = tempfile.mkdtemp(prefix='vector_new_')
            for src in att_sources:
                try:
                    src_item = ns.GetItemFromID(src['entryId'])
                    att      = src_item.Attachments.Item(src['index'])
                    safe     = att.FileName.replace('/', '_').replace('\\', '_')
                    tmp_path = os.path.join(tmp_dir, safe)
                    att.SaveAsFile(tmp_path)
                    mail.Attachments.Add(tmp_path)
                except Exception as ae:
                    print(f'[WARN] Could not attach {src}: {ae}', file=sys.stderr)

            if args.draft:
                # Leave it in Drafts and pop the composer, so the mail is never
                # sent without a human pressing Send in Outlook.
                mail.Save()
                try:
                    mail.Display()
                except Exception:
                    pass
                print(json.dumps({'ok': True, 'draft': True, 'entryId': mail.EntryID}))
                return

            mail.Send()
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return


# ─── Graph API action dispatcher ──────────────────────────────────────────────
def _graph_action(args, token):

    if args.action == 'mailboxes':
        try:
            user = _gget(token, '/me', params={'$select': 'displayName,mail'})
            name  = user.get('displayName') or user.get('mail', 'My Mailbox')
            email = user.get('mail', '')
            print(json.dumps({'mailboxes': [{
                'storeId':   'graph:primary',
                'name':      f'{name} ({email})',
                'type':      'personal',
                'inboxName': 'Inbox',
            }]}))
        except Exception as e:
            print(json.dumps({'mailboxes': [], 'error': str(e)}))
        return

    if args.action == 'emails':
        try:
            params = {
                '$top':     args.limit,
                '$orderby': 'receivedDateTime desc',
                '$select':  'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments',
                '$expand':  'attachments($select=id,name,size)',
            }
            if args.unread:
                params['$filter'] = 'isRead eq false'
            data   = _gget(token, '/me/mailFolders/inbox/messages', params=params)
            emails = [_graph_summary(m) for m in data.get('value', [])]
            print(json.dumps({'emails': emails}))
        except Exception as e:
            print(json.dumps({'emails': [], 'error': str(e)}))
        return

    if args.action == 'email':
        if not args.id:
            print(json.dumps({'error': 'No entry ID provided'}))
            return
        try:
            msg = _gget(token, f'/me/messages/{args.id}', params={
                '$select': 'id,subject,from,toRecipients,ccRecipients,'
                           'receivedDateTime,body,isRead,hasAttachments,flag,categories',
            })
            atts = _graph_att_list(token, args.id) if msg.get('hasAttachments') else []

            # Mark as read
            if not msg.get('isRead'):
                try:
                    _gpatch(token, f'/me/messages/{args.id}', {'isRead': True})
                except Exception:
                    pass

            frm       = msg.get('from', {}).get('emailAddress', {})
            to_list   = [r.get('emailAddress', {}).get('address', '')
                         for r in msg.get('toRecipients', [])]
            cc_list   = [r.get('emailAddress', {}).get('address', '')
                         for r in msg.get('ccRecipients', [])]
            body_obj  = msg.get('body', {})
            ct        = body_obj.get('contentType', '').lower()
            html_body = body_obj.get('content', '') if ct == 'html' else ''
            plain     = body_obj.get('content', '') if ct == 'text' else ''
            if not plain and html_body:
                plain = re.sub(r'<[^>]+>', ' ', html_body)
                plain = re.sub(r'[ \t]+', ' ', plain).strip()
            flag    = msg.get('flag', {}).get('flagStatus', 'notFlagged')
            cats    = ', '.join(msg.get('categories', []))

            print(json.dumps({
                'entryId':     msg['id'],
                'subject':     msg.get('subject') or '(no subject)',
                'sender':      frm.get('name', ''),
                'senderEmail': frm.get('address', ''),
                'to':          ', '.join(to_list),
                'cc':          ', '.join(cc_list),
                'received':    msg.get('receivedDateTime', ''),
                'body':        plain[:6000],
                'htmlBody':    html_body,
                'unread':      not msg.get('isRead', True),
                'attachments': atts,
                'hasPdf':      any(a.get('isPdf') for a in atts),
                'flagged':     flag == 'flagged',
                'categories':  cats,
            }))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'save-attachment':
        if not args.id or not args.dest:
            print(json.dumps({'error': 'entryId and dest are required'}))
            return
        try:
            atts = _graph_att_list(token, args.id)
            pdf_atts = [a for a in atts if a['isPdf']]
            os.makedirs(args.dest, exist_ok=True)
            saved = []
            for att in pdf_atts:
                content   = _gget_raw(token,
                    f'/me/messages/{args.id}/attachments/{att["graphId"]}/$value')
                dest_path = os.path.join(args.dest, att['name'])
                open(dest_path, 'wb').write(content)
                saved.append({'name': att['name'], 'path': dest_path})
            # Mark as read
            try:
                _gpatch(token, f'/me/messages/{args.id}', {'isRead': True})
            except Exception:
                pass
            print(json.dumps({'saved': saved, 'count': len(saved)}))
        except Exception as e:
            print(json.dumps({'error': str(e), 'saved': []}))
        return

    if args.action == 'get-attachment':
        if not args.id or not args.dest or not args.index:
            print(json.dumps({'error': 'entryId, dest and index required'}))
            return
        try:
            atts = _graph_att_list(token, args.id)
            if args.index < 1 or args.index > len(atts):
                print(json.dumps({'error': f'Attachment index {args.index} out of range'}))
                return
            att     = atts[args.index - 1]
            content = _gget_raw(token,
                f'/me/messages/{args.id}/attachments/{att["graphId"]}/$value')
            os.makedirs(args.dest, exist_ok=True)
            safe      = att['name'].replace('/', '_').replace('\\', '_')
            dest_path = os.path.join(args.dest,
                f'att_{abs(hash(args.id)) % 100000}_{args.index}_{safe}')
            open(dest_path, 'wb').write(content)
            print(json.dumps({'path': dest_path, 'name': att['name'], 'size': att['size']}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-reply':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body required'}))
            return
        try:
            _gpost(token, f'/me/messages/{args.id}/reply', {'comment': args.body})
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'flag':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            status = 'flagged' if args.flagged else 'notFlagged'
            _gpatch(token, f'/me/messages/{args.id}', {'flag': {'flagStatus': status}})
            print(json.dumps({'ok': True, 'flagged': bool(args.flagged)}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'mark-unread':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _gpatch(token, f'/me/messages/{args.id}', {'isRead': False})
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'delete':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            _gpost(token, f'/me/messages/{args.id}/move', {'destinationId': 'deleteditems'})
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'forward':
        if not args.id or not args.to:
            print(json.dumps({'error': 'entryId and to required'}))
            return
        try:
            to_recip = [{'emailAddress': {'address': a.strip()}}
                        for a in args.to.split(';') if a.strip()]
            body: dict = {'toRecipients': to_recip}
            if args.body:
                body['comment'] = args.body
            _gpost(token, f'/me/messages/{args.id}/forward', body)
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'open-in-outlook':
        # New Outlook doesn't have a COM interface; open in Outlook Web App instead
        print(json.dumps({
            'ok':  False,
            'url': f'https://outlook.office.com/mail/inbox',
            'error': 'Open-in-Outlook not available with Graph API — use the web link',
        }))
        return

    if args.action == 'categorize':
        if not args.id:
            print(json.dumps({'error': 'entryId required'}))
            return
        try:
            cats = [args.category] if args.category else []
            _gpatch(token, f'/me/messages/{args.id}', {'categories': cats})
            print(json.dumps({'ok': True, 'category': args.category}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'suggest-attachments':
        query = args.query.strip()
        if not query:
            print(json.dumps({'results': []}))
            return
        try:
            # Build search string from SF ID + keywords
            sf_match = re.search(r'SR00[A-Za-z0-9]+', query, re.IGNORECASE)
            sf_id    = sf_match.group(0) if sf_match else ''
            words    = [w for w in re.split(r'\W+', query) if len(w) > 3][:3]
            search_q = sf_id or ' '.join(words) or query[:50]

            data = _gget(token, '/me/messages', params={
                '$search':  f'"{search_q}"',
                '$top':     20,
                '$select':  'id,subject,from,receivedDateTime,hasAttachments',
            })
            results = []
            for msg in data.get('value', []):
                if not msg.get('hasAttachments'):
                    continue
                frm = msg.get('from', {}).get('emailAddress', {})
                try:
                    att_data = _gget(token, f'/me/messages/{msg["id"]}/attachments',
                                     params={'$select': 'id,name,size'})
                except Exception:
                    continue
                for i, att in enumerate(att_data.get('value', []), 1):
                    name = att.get('name', '') or ''
                    if not name.lower().endswith('.pdf'):
                        continue
                    results.append({
                        'sourceEntryId':   msg['id'],
                        'attachmentIndex': i,
                        'attachmentName':  name,
                        'attachmentSize':  att.get('size', 0),
                        'emailSubject':    msg.get('subject') or '(no subject)',
                        'sender':          frm.get('name', ''),
                        'received':        msg.get('receivedDateTime', ''),
                        'score':           1,
                        'graphAttId':      att.get('id', ''),
                    })
                    if len(results) >= 6:
                        break
                if len(results) >= 6:
                    break
            print(json.dumps({'results': results}))
        except Exception as e:
            print(json.dumps({'results': [], 'error': str(e)}))
        return

    if args.action == 'reply-with-attachments':
        if not args.id or not args.body:
            print(json.dumps({'error': 'entryId and body required'}))
            return
        try:
            draft_r  = _gpost(token, f'/me/messages/{args.id}/createReply',
                              {'comment': args.body})
            draft_id = draft_r.json()['id']

            att_sources = json.loads(args.att_sources or '[]')
            for src in att_sources:
                try:
                    src_id  = src.get('entryId', '')
                    att_idx = src.get('index', 1)
                    src_atts = _graph_att_list(token, src_id)
                    if att_idx < 1 or att_idx > len(src_atts):
                        continue
                    att     = src_atts[att_idx - 1]
                    content = _gget_raw(token,
                        f'/me/messages/{src_id}/attachments/{att["graphId"]}/$value')
                    _gpost(token, f'/me/messages/{draft_id}/attachments', {
                        '@odata.type':  '#microsoft.graph.fileAttachment',
                        'name':         att['name'],
                        'contentBytes': base64.b64encode(content).decode(),
                    })
                except Exception as ae:
                    sys.stderr.write(f'[WARN] attach failed: {ae}\n')

            _gpost(token, f'/me/messages/{draft_id}/send')
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return

    if args.action == 'send-new':
        if not args.to or not args.subject:
            print(json.dumps({'error': 'to and subject required'}))
            return
        try:
            to_recip = [{'emailAddress': {'address': a.strip()}}
                        for a in args.to.split(';') if a.strip()]
            att_sources = json.loads(args.att_sources or '[]')
            attachments = []
            for src in att_sources:
                try:
                    src_id   = src.get('entryId', '')
                    att_idx  = src.get('index', 1)
                    src_atts = _graph_att_list(token, src_id)
                    if att_idx < 1 or att_idx > len(src_atts):
                        continue
                    att     = src_atts[att_idx - 1]
                    content = _gget_raw(token,
                        f'/me/messages/{src_id}/attachments/{att["graphId"]}/$value')
                    attachments.append({
                        '@odata.type':  '#microsoft.graph.fileAttachment',
                        'name':         att['name'],
                        'contentBytes': base64.b64encode(content).decode(),
                    })
                except Exception as ae:
                    sys.stderr.write(f'[WARN] attach failed: {ae}\n')

            msg_payload: dict = {
                'subject':      args.subject,
                'body':         {'contentType': 'text', 'content': args.body or ''},
                'toRecipients': to_recip,
            }
            if attachments:
                msg_payload['attachments'] = attachments

            _gpost(token, '/me/sendMail',
                   {'message': msg_payload, 'saveToSentItems': True})
            print(json.dumps({'ok': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
        return


if __name__ == '__main__':
    main()
