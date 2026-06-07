"""
outlook_win32_connector.py
==========================
Finds Outlook emails that match a D&Q quote (by SF ID / quote name) using
win32com directly — no OAuth, no Graph token, no email-drop folder needed.

Returns matched emails as .msg files + any non-PDF attachments, ready to
upload to SharePoint.
"""
import os
import re


# Senders whose emails should never be copied into the D&Q Store
_EXCLUDE_SENDERS = {
    "manualnotification@eaton.com",
    "ukquotefactoryel@eaton.com",
    "noreply@eaton.com",
}

# Folder names considered "inbox" in various Outlook locales
_INBOX_NAMES = {
    'inbox', 'boîte de réception', 'posteingang',
    'bandeja de entrada', 'postvak in', 'gelen kutusu',
    'входящие', 'posta in arrivo',
}


def _score(subject, body, sf_id, qn_words):
    text = (subject + " " + body).lower()
    score = 0
    if sf_id and sf_id.lower().strip() in text:
        score += 10
    score += sum(1 for w in qn_words if w in text)
    return score


def find_matching_emails(sf_id, quote_name, tmp_dir, max_emails=3):
    """
    Search every available Outlook inbox (personal + shared) for emails
    that mention sf_id and/or words from quote_name.

    Returns a list (sorted best-first) of dicts:
        {
          "email_path":  str,            # path to saved .msg in tmp_dir
          "attachments": [(name, path)], # non-PDF attachments
          "score":       int,
          "subject":     str,
        }

    Returns [] if pywin32 is unavailable or Outlook is not running.
    """
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        print("  [!] pywin32 not installed — skipping email match", flush=True)
        return []

    try:
        pythoncom.CoInitialize()
        outlook = win32com.client.Dispatch("Outlook.Application")
        ns      = outlook.GetNamespace("MAPI")
    except Exception as e:
        print(f"  [!] Outlook not available: {e}", flush=True)
        return []

    sf_lower = (sf_id or "").lower().strip()
    qn_words = [w.lower() for w in re.split(r'\W+', quote_name or "") if len(w) > 3]

    # Collect all inboxes (personal + shared stores)
    inboxes = []
    try:
        inboxes.append(ns.GetDefaultFolder(6))   # personal olFolderInbox
    except Exception:
        pass
    try:
        for i in range(1, ns.Stores.Count + 1):
            store = ns.Stores.Item(i)
            root  = store.GetRootFolder()
            for j in range(1, root.Folders.Count + 1):
                f = root.Folders.Item(j)
                if f.Name.lower() in _INBOX_NAMES:
                    inboxes.append(f)
                    break
    except Exception:
        pass

    results  = []
    seen_ids = set()

    for inbox in inboxes:
        try:
            items = inbox.Items
            items.Sort("[ReceivedTime]", True)   # newest first
            scanned = 0
            for item in items:
                if scanned >= 300 or len(results) >= max_emails:
                    break
                try:
                    if item.Class != 43:          # 43 = olMail
                        continue
                    scanned += 1

                    entry_id = item.EntryID
                    if entry_id in seen_ids:
                        continue
                    seen_ids.add(entry_id)

                    sender = (item.SenderEmailAddress or "").lower()
                    if any(ex in sender for ex in _EXCLUDE_SENDERS):
                        continue

                    subject = item.Subject or ""
                    body    = (item.Body or "")[:3000]
                    score   = _score(subject, body, sf_lower, qn_words)

                    if score < 3:
                        continue

                    # ── Save email as .msg ────────────────────────────────────
                    safe_subj = re.sub(r'[\\/:*?"<>|]', '_', subject)[:60].strip() or "email"
                    msg_path  = os.path.join(tmp_dir, f"{safe_subj}.msg")
                    try:
                        item.SaveAs(msg_path, 3)   # olMSG = 3
                    except Exception as exc:
                        print(f"  [!] Could not save .msg: {exc}", flush=True)
                        continue

                    # ── Collect non-PDF attachments ───────────────────────────
                    attachments = []
                    for k in range(1, item.Attachments.Count + 1):
                        try:
                            att = item.Attachments.Item(k)
                            if att.FileName.lower().endswith('.pdf'):
                                continue    # PDF already handled separately
                            safe_name = re.sub(r'[\\/:*?"<>|]', '_', att.FileName)
                            att_path  = os.path.join(tmp_dir, f"att_{k}_{safe_name}")
                            att.SaveAsFile(att_path)
                            attachments.append((att.FileName, att_path))
                        except Exception:
                            pass

                    results.append({
                        "email_path":  msg_path,
                        "attachments": attachments,
                        "score":       score,
                        "subject":     subject or "(no subject)",
                    })
                    print(f"  [+] Email match (score={score}): {subject or '(no subject)'}",
                          flush=True)

                except Exception:
                    continue

        except Exception as e:
            print(f"  [!] Error scanning inbox: {e}", flush=True)

    results.sort(key=lambda x: -x["score"])
    return results[:max_emails]
