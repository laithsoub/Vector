"""
outlook_reader.py — Read/write emails via Outlook desktop (win32com) or Microsoft Graph API.

Actions: status, mailboxes, emails, email, save-attachment, send-reply, get-attachment,
         flag, mark-unread, delete, forward, open-in-outlook, categorize,
         suggest-attachments, reply-with-attachments, send-new, graph-connect
Output: JSON to stdout
"""
import sys, json, os, re, argparse, tempfile, base64

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


def att_info(att):
    return {
        'index': att.Index,
        'name':  att.FileName,
        'size':  att.Size,
        'isPdf': att.FileName.lower().endswith('.pdf'),
    }


def resolve_smtp(item):
    """Return the real SMTP address, resolving Exchange internal /O=... format."""
    try:
        addr = item.SenderEmailAddress or ''
        if not addr or not (addr.upper().startswith('/O=') or addr.upper().startswith('EX:')):
            return addr
        sender = item.Sender
        if sender:
            try:
                ex_user = sender.GetExchangeUser()
                if ex_user:
                    smtp = ex_user.PrimarySmtpAddress
                    if smtp:
                        return smtp
            except Exception:
                pass
            try:
                ex_dl = sender.GetExchangeDistributionList()
                if ex_dl:
                    smtp = ex_dl.PrimarySmtpAddress
                    if smtp:
                        return smtp
            except Exception:
                pass
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
    return {
        'index':   idx,
        'name':    name,
        'size':    att.get('size', 0),
        'isPdf':   name.lower().endswith('.pdf'),
        'graphId': att.get('id', ''),
    }


def _graph_att_list(token, msg_id):
    data = _gget(token, f'/me/messages/{msg_id}/attachments',
                 params={'$select': 'id,name,size,contentType'})
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
            atts.append({
                'index': idx, 'name': fname, 'size': len(content),
                'isPdf': fname.lower().endswith('.pdf'),
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
        'current-selection',
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
