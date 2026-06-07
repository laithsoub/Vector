"""
schematic_reader.py — Eaton Emergency Lighting material extraction + pricing.

Modes:
  --mode pdf      <pdf_path>     Extract items from a PDF schematic using AI vision
  --mode image    <img_path>     Extract items from a photo / screenshot
  --mode list     <text_path>    Price a direct material list (cat nos or descriptions)
  --mode unified  <json_path>    JSON manifest combining text + N attachments. Auto-routes:
                                    explicit cat-no  → fast price-list lookup
                                    descriptive text → Gemini + Google Search candidates
                                    image + text     → combined multimodal candidate search

Output: JSON to stdout
  {
    "items": [...],
    "unmatched": [...],
    "total_ntp": 123.45,
    "candidates": [...],   # ranked descriptive/visual matches with confidence + reasoning
    "source": "pdf" | "image" | "list" | "unified",
    "extracted_count": <n>
  }
"""
import sys, json, os, re, base64, argparse, ssl
import urllib.request, urllib.error

# Corporate SSL inspection proxies: don't verify certificates (same as Node.js server)
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode    = ssl.CERT_NONE

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PRICELIST   = os.path.join(SCRIPT_DIR, 'el_pricelist.xlsx')
CONFIG_PATH = os.path.join(SCRIPT_DIR, 'config.json')

# ── Eaton EL product knowledge ────────────────────────────────────────────────
EL_FAMILIES = [
    'Micropoint 2', 'Micropoint 2 Surface',
    'CrystalWay',
    'RoundTech MR EC', 'RoundTech MR SEO', 'RoundTech MS SEO',
    'NexiLite', 'NexiTech LED',
    'BeamLite II', 'BeamTech',
    'FlexiTech ED', 'FlexiTech SE', 'FlexiTech SU - EW - EC', 'FlexiTech Tube',
    'SafeLite', 'SpiritLED',
    'Atlantic LED', 'Atlantic LED II', 'Atlantic LED II LT', 'Atlantic LED LT',
    'EXIT LED', 'EXIT LED 2', 'Exit Cube LED', 'Exit SE LED', 'EuroXLED',
    'EURO LED', 'Style LED', 'Style II LED', 'Style LED Variant', 'Style',
    'GuideLed', 'GuideLed DX-DXC', 'GuideLed SL', 'GuideLed SL II', 'GuideLed SL III',
    'VisionGuard',
    'CGLine+ Monitoring system', 'Matrix CGLine+',
    'Batteries CPS',
    'Mondia', 'Velos', 'Olisq', 'Brillant LED',
    'LP-STAR', 'AT-S+', 'AE-CGLine+',
    'ZB-S', 'ZB 96',
    'TL Telecommands', 'Remote Control Modul',
    'Conversion kit LED',
    'Outdoor Wall', 'Outdoor Wall II',
    'Step light', 'HandRail 930XX LED',
    'i-P65', 'i-P65 Plus',
    'ExLin',
]

EL_KEYWORDS = [
    'micropoint', 'crystalway', 'roundtech', 'nexilite', 'nexitech',
    'beamlite', 'beamtech', 'flexitech', 'safelite', 'spiritled',
    'atlantic led', 'exit led', 'exitcube', 'eurolxled', 'euro led', 'eurosxled',
    'styleled', 'style led', 'guideled', 'visionguard',
    'cgline', 'cg-s', 'cg2000',
    'emergency', 'escape route', 'anti-panic', 'safety luminaire',
    'maintained', 'non-maintained', 'central battery',
    'mp2', 'nxl', 'lum222', 'at-s', 'lp-star',
    'eaton el', 'eaton emergency',
    'mondia', 'velos', 'olisq', 'brillant',
    'exlin',
    # Cooper = former Eaton brand — always include
    'cooper', 'menvier', 'ceag', 'merel', 'exloc', 'cooper safety',
    'cooper industries', 'crouse-hinds',
]


def load_config():
    try:
        return json.loads(open(CONFIG_PATH, encoding='utf-8').read())
    except Exception:
        return {}


def load_pricelist():
    """Load the EL price list.

    Returns (lookup, entries):
      lookup  – dict keyed by normalised part number for fast cat_no matching
      entries – deduplicated list of all entries for description/family search
    """
    try:
        import pandas as pd
        df = pd.read_excel(PRICELIST, sheet_name='Price_DB', skiprows=2)
        df.columns = df.iloc[0].tolist()
        df = df.iloc[1:].reset_index(drop=True)
        df.columns = [str(c).strip() for c in df.columns]

        lookup  = {}   # normalised_cat_no -> entry dict
        seen    = {}   # cat_no (original case) -> entry dict, for dedup

        for _, row in df.iterrows():
            cat = str(row.get('Part-Number', '') or '').strip()
            if not cat or cat == 'nan':
                continue
            try:
                list_p = float(row.get('List Price in £', 0) or 0)
                ntp    = float(row.get('NTP (less discount) in £', 0) or 0)
            except Exception:
                list_p = ntp = 0.0

            desc   = str(row.get('Description English', '') or '').strip()
            family = str(row.get('Family', '') or '').strip()
            status = str(row.get('Status', '') or '').strip()

            entry = {
                'cat_no':      cat,
                'description': desc,
                'family':      family,
                'list_price':  list_p,
                'ntp':         ntp,
                'status':      status,
            }
            lookup[cat.upper()] = entry
            lookup[cat.upper().replace('-', '').replace(' ', '')] = entry
            seen[cat] = entry

        entries = list(seen.values())
        sys.stderr.write(f'[pricelist] loaded {len(df)} rows, {len(entries)} unique part numbers\n')
        return lookup, entries

    except Exception as e:
        sys.stderr.write(f'[pricelist] ERROR loading price list: {e}\n')
        return {}, []


def match_item_with_type(cat_no: str, lookup: dict) -> tuple['dict | None', str]:
    """Try to find a catalogue number. Returns (match, match_type).
    match_type: 'exact' | 'fuzzy' | '' (no match)."""
    cat_no = cat_no.strip()
    if not cat_no:
        return None, ''
    key  = cat_no.upper()
    key2 = key.replace('-', '').replace(' ', '')

    # Special i-P65 pre-processing: "i-P65 O CG-S" → try IP65OCGS and variants
    if re.match(r'^i[-\s]*p65', cat_no, re.I):
        # Strip leading 'i-' and normalise separators
        stripped  = re.sub(r'^i[-\s]*', '', cat_no.strip(), flags=re.I)
        clean     = re.sub(r'[\s\-/\.]+', '', stripped.upper())   # P65OCGS
        full_key  = re.sub(r'[\s\-/\.]+', '', cat_no.upper())     # IP65OCGS
        candidates = {clean, full_key,
                      'IP65' + clean[3:] if clean.startswith('P65') else clean,
                      clean.replace('O', '0'), clean.replace('0', 'O'),
                      full_key.replace('O', '0'), full_key.replace('0', 'O')}
        for cand in candidates:
            if cand in lookup:
                return lookup[cand], 'fuzzy'
            # Also check the lookup normalised form (no hyphens/spaces)
            for k, v in lookup.items():
                if k.replace('-', '').replace(' ', '') == cand:
                    return v, 'fuzzy'

    # 1. Exact match
    if key in lookup:
        return lookup[key], 'exact'
    # 2. Without hyphens/spaces
    if key2 in lookup:
        return lookup[key2], 'exact'
    # 3. Prefix: extracted is the start of a longer part number (≤4 extra chars)
    for k, v in lookup.items():
        if k.startswith(key2) and 0 < len(k) - len(key2) <= 4:
            return v, 'fuzzy'
    # 4. Suffix: extracted ends a full part number (≤4 leading chars missing)
    if len(key2) >= 4:
        for k, v in lookup.items():
            if k.endswith(key2) and 0 < len(k) - len(key2) <= 4:
                return v, 'fuzzy'
    # 5. Extracted contains a full price-list key as substring (key ≥ 5 chars)
    for k, v in lookup.items():
        if len(k) >= 5 and k in key2:
            return v, 'fuzzy'
    # 6. Price-list key contains the extracted as substring (extracted ≥ 5 chars, ≤6 extra)
    if len(key2) >= 5:
        for k, v in lookup.items():
            if key2 in k and len(k) - len(key2) <= 6:
                return v, 'fuzzy'
    # 7. 0 ↔ O swap — common OCR/scan misread (e.g. MP203H → MP2O3H)
    if '0' in key2 or 'O' in key2:
        variants: set[str] = set()
        variants.add(key2.replace('0', 'O'))
        variants.add(key2.replace('O', '0'))
        for i, c in enumerate(key2):
            if c == '0':
                variants.add(key2[:i] + 'O' + key2[i+1:])
            elif c == 'O':
                variants.add(key2[:i] + '0' + key2[i+1:])
        variants.discard(key2)
        for variant in variants:
            if variant in lookup:
                return lookup[variant], 'fuzzy'
    return None, ''


def match_item(cat_no: str, lookup: dict) -> 'dict | None':
    """Backward-compatible wrapper — returns match dict or None."""
    return match_item_with_type(cat_no, lookup)[0]


def match_by_description(text: str, entries: list[dict]) -> tuple['dict | None', str]:
    """Search price list entries by description or family name keywords.
    Returns (match, 'description') or (None, '').
    """
    text_lower = text.lower().strip()
    if not text_lower:
        return None, ''
    is_ip65 = bool(re.match(r'i[-\s]*p65|ip65', text_lower))
    words = [w for w in re.split(r'[\s\-_/]+', text_lower) if len(w) >= 3]
    if not words:
        return None, ''

    best_score = 0
    best_entry = None
    for entry in entries:
        combined = (
            (entry.get('description', '') or '') + ' ' +
            (entry.get('family', '') or '') + ' ' +
            (entry.get('cat_no', '') or '')
        ).lower()
        score = sum(1 for w in words if w in combined)
        # Boost i-P65 family entries when query looks like an i-P65 item
        if is_ip65 and 'p65' in (entry.get('family', '') or '').lower():
            score += 5
        # Penalise Style/Style LED family when query is i-P65
        if is_ip65 and re.search(r'\bstyle\b', (entry.get('family', '') or ''), re.I):
            score = max(0, score - 3)
        if score > best_score:
            best_score = score
            best_entry = entry

    threshold = max(1, len(words) // 2)
    if best_score >= threshold:
        return best_entry, 'description'
    return None, ''


def parse_gemini_items(text: str) -> list[dict]:
    """Accept Gemini JSON array, fenced JSON, or {"items": [...]} wrappers."""
    cleaned = text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, flags=re.I)
    cleaned = re.sub(r'\s*```$', '', cleaned)

    try:
        parsed = json.loads(cleaned)
    except Exception:
        start = cleaned.find('[')
        end = cleaned.rfind(']')
        if start == -1 or end <= start:
            start = cleaned.find('{')
            end = cleaned.rfind('}')
        if start == -1 or end <= start:
            raise
        parsed = json.loads(cleaned[start:end + 1])

    if isinstance(parsed, dict):
        parsed = parsed.get('items') or parsed.get('data') or []
    return parsed if isinstance(parsed, list) else []


def extract_from_image(image_path: str, api_key: str) -> list[dict]:
    """Use Gemini vision to extract EL items from an image (photo, screenshot, scan)."""
    import mimetypes
    mime_type = mimetypes.guess_type(image_path)[0] or 'image/png'
    sys.stderr.write(f'[image] extracting from {image_path} ({mime_type}) via Gemini\n')

    with open(image_path, 'rb') as f:
        img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')

    prompt = (
        'You are an expert in Eaton and Cooper emergency lighting products.\n\n'
        'CRITICAL: Eaton acquired Cooper Industries, so Cooper Safety, Menvier, Ceag, Merel, '
        'Exloc, and all Cooper brands are Eaton products. ALWAYS include them.\n\n'
        'Extract EVERY emergency lighting item from this image that belongs to Eaton '
        'or any Eaton-group brand (Cooper Safety, Menvier, Ceag, Merel, Exloc, etc.).\n\n'
        'Return ONLY a JSON array. Each item:\n'
        '{"cat_no": "...", "description": "...", "qty": <number>, "ref": "..."}\n\n'
        'Eaton/Cooper EL families: ' + ', '.join(EL_FAMILIES) + '\n\n'
        'Catalogue number formats: MP2ES230CGS, NXL100, LUM22216, 40071354592, and Cooper formats.\n\n'
        'RULES — follow strictly:\n'
        '- A line saying "Cooper" with a catalogue number → INCLUDE IT\n'
        '- A line with an Eaton catalogue number format even without the brand name → INCLUDE IT\n'
        '- If uncertain whether an item is Eaton/Cooper → INCLUDE IT; do NOT skip it\n'
        '- If schematic: extract circuit refs (E1, EM1, EX1 …) and luminaire type\n'
        '- If material list, spreadsheet or handwritten list: extract every line with its quantity\n'
        '- Combine duplicate catalogue numbers by summing quantities\n'
        '- Quantity defaults to 1 if not shown\n'
        '- i-P65 products: the full catalogue number includes mount/variant code. '
        '  If you see text like "i-P65 O CG-S" or "i-P65/0/CG-S", the O/0 is a variant — '
        '  include it exactly as written in cat_no (e.g. "IP65OCGS" or "I-P65-O-CG-S")\n'
        '- For i-P65, also try: IP65LED...CGS, IP65LEDCGS, IP65CGNM patterns\n\n'
        'Be EXHAUSTIVE. It is better to include a doubtful item than to miss a real one.\n'
        'Return ONLY the JSON array, no markdown, no explanation.'
    )

    payload = json.dumps({
        'contents': [{
            'parts': [
                {'inline_data': {'mime_type': mime_type, 'data': img_b64}},
                {'text': prompt}
            ]
        }],
        'generationConfig': {'maxOutputTokens': 4096, 'temperature': 0.1}
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        text = resp['candidates'][0]['content']['parts'][0]['text'].strip()
        sys.stderr.write(f'[image] Gemini response: {text[:200]}\n')
        return parse_gemini_items(text)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[image] Gemini API error {e.code}: {body[:300]}\n')
        raise RuntimeError(f'Gemini API error {e.code}: {body[:300]}')
    except Exception as e:
        sys.stderr.write(f'[image] extraction error: {e}\n')
        raise RuntimeError(f'Image extraction failed: {e}')


def identify_product_candidates(image_path: str, api_key: str) -> list[dict]:
    """Use Gemini vision + Google Search to visually identify what Eaton/Cooper
    emergency lighting product the photo most likely is. Returns up to 5 candidate
    catalogue numbers ranked by visual similarity, no hard-coded family filtering.
    """
    import mimetypes
    mime_type = mimetypes.guess_type(image_path)[0] or 'image/png'
    sys.stderr.write(f'[identify] visual product search for {image_path}\n')

    with open(image_path, 'rb') as f:
        img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')

    prompt = (
        'You are looking at a photograph of an emergency / safety lighting product.\n\n'
        'Use Google Search to find what Eaton or Cooper (including Cooper Safety, Menvier, '
        'Ceag, Merel, Exloc, Crouse-Hinds) emergency lighting product is most likely shown '
        'in the photo, based purely on visual appearance — shape, housing, lens, mounting, '
        'pictogram, colour, branding marks. Search Eaton product catalogues, datasheets and '
        'distributor sites that show product images.\n\n'
        'Return the TOP 5 most likely candidate catalogue numbers, ranked by visual '
        'similarity. Do NOT filter by family preference; include any Eaton-group EL family '
        'whose product visually matches.\n\n'
        'Return ONLY a JSON array (no markdown, no prose):\n'
        '[\n'
        '  {\n'
        '    "cat_no":      "<full Eaton/Cooper catalogue number>",\n'
        '    "family":      "<product family name>",\n'
        '    "description": "<short product description>",\n'
        '    "confidence":  "high" | "medium" | "low",\n'
        '    "reasoning":   "<one sentence: what in the photo led to this match>",\n'
        '    "source_url":  "<Eaton/datasheet/distributor URL you grounded on, or empty>"\n'
        '  }\n'
        ']'
    )

    payload = json.dumps({
        'contents': [{
            'parts': [
                {'inline_data': {'mime_type': mime_type, 'data': img_b64}},
                {'text': prompt},
            ],
        }],
        'tools': [{'google_search': {}}],
        'generationConfig': {
            'maxOutputTokens': 8192,
            'temperature':     0.3,
            'thinkingConfig':  {'thinkingBudget': 0},
        },
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        cand = resp.get('candidates', [{}])[0]
        parts_out = cand.get('content', {}).get('parts', []) or []
        text = ''.join(p.get('text', '') for p in parts_out).strip()
        sys.stderr.write(f'[identify] finish={cand.get("finishReason","")} parts={len(parts_out)} len={len(text)}\n')
        sys.stderr.write(f'[identify] preview: {text[:300]}\n')
        parsed = parse_gemini_items(text)
        return [c for c in parsed if isinstance(c, dict) and c.get('cat_no')]
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[identify] Gemini API error {e.code}: {body[:300]}\n')
        return []
    except Exception as e:
        sys.stderr.write(f'[identify] error: {e}\n')
        return []


def describe_items_in_image(image_path: str, api_key: str) -> list[dict]:
    """Enumerate DISTINCT emergency-lighting items visible in a photo.

    Returns one entry per item: {label, keywords, qty}. NO catalogue numbers
    are invented — that's the job of the grounded reranker downstream.

    The label is a short human-readable phrase ("Right-arrow exit sign,
    wall-mounted, item 1"). The keywords field is a denser space-separated
    string used for keyword_pool() filtering.
    """
    import mimetypes
    if not os.path.exists(image_path):
        return []
    mime_type = mimetypes.guess_type(image_path)[0] or 'image/png'
    try:
        with open(image_path, 'rb') as f:
            img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')
    except Exception as e:
        sys.stderr.write(f'[items] could not read {image_path}: {e}\n')
        return []

    prompt = (
        'Look at this photo and enumerate every DISTINCT emergency / safety '
        'lighting product you can see (exit signs, escape route luminaires, '
        'anti-panic, emergency bulkheads, etc.).\n\n'
        'For each distinct product return one JSON object with:\n'
        '  "label":    short human description, e.g. "Right-arrow exit sign, wall-mounted"\n'
        '  "keywords": 8-15 space-separated descriptive keywords covering type, mounting, '
        '              pictogram, lens, housing, environment, brand markings if visible. '
        '              These keywords drive a price-list search downstream.\n'
        '  "qty":      integer quantity visible in the image (default 1)\n\n'
        'CRITICAL: DO NOT invent or guess a catalogue / model / part number — leave that out.\n'
        'If two visible products are the SAME model (e.g. two identical exit signs on the same '
        'wall), combine them into ONE entry with qty=2. If two products differ even slightly '
        '(different pictogram, different mounting, different housing), return them as separate entries.\n\n'
        'Return ONLY a JSON array of these objects, no markdown, no prose.'
    )

    payload = json.dumps({
        'contents': [{'parts': [
            {'inline_data': {'mime_type': mime_type, 'data': img_b64}},
            {'text': prompt},
        ]}],
        'generationConfig': {
            'maxOutputTokens': 2048,
            'temperature':     0.1,
            'thinkingConfig':  {'thinkingBudget': 0},
        },
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=90, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        cand = resp.get('candidates', [{}])[0]
        parts_out = cand.get('content', {}).get('parts', []) or []
        text = ''.join(p.get('text', '') for p in parts_out).strip()
        sys.stderr.write(f'[items] {os.path.basename(image_path)}: len={len(text)}\n')
        sys.stderr.write(f'[items] preview: {text[:300]}\n')
        parsed = parse_gemini_items(text)
        out: list[dict] = []
        for it in parsed:
            if not isinstance(it, dict):
                continue
            label = str(it.get('label', '') or '').strip()
            kws   = str(it.get('keywords', '') or '').strip()
            if not label and not kws:
                continue
            qty = it.get('qty')
            try:
                qty = int(qty) if qty else 1
            except Exception:
                qty = 1
            out.append({'label': label, 'keywords': kws, 'qty': max(1, qty)})
        return out
    except Exception as e:
        sys.stderr.write(f'[items] error: {e}\n')
        return []


def derive_image_keywords(image_path: str, api_key: str) -> str:
    """Have Gemini describe an EL product image in keywords ONLY — no cat-numbers invented.
    Returns a short string of descriptive keywords used downstream for price-list keyword search."""
    import mimetypes
    if not os.path.exists(image_path):
        return ''
    mime_type = mimetypes.guess_type(image_path)[0] or 'image/png'
    try:
        with open(image_path, 'rb') as f:
            img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')
    except Exception as e:
        sys.stderr.write(f'[keywords] could not read {image_path}: {e}\n')
        return ''

    prompt = (
        'Look at this emergency / safety lighting product photo and describe it in 8-12 short '
        'keywords ONLY. Cover: product type (exit sign, escape route luminaire, anti-panic, '
        'emergency bulkhead), mounting (wall, ceiling, recessed, surface, suspended, pendant), '
        'housing (slim, round, square, rectangular, aluminium, plastic), lens / pictogram (running man, '
        'arrow, EXIT text), IP rating if visible, brand markings if visible.\n\n'
        'DO NOT invent a catalogue number or part number. NO cat_no, NO model number.\n'
        'Return just the keywords separated by spaces — no prose, no JSON, no quotes.'
    )

    payload = json.dumps({
        'contents': [{'parts': [
            {'inline_data': {'mime_type': mime_type, 'data': img_b64}},
            {'text': prompt},
        ]}],
        'generationConfig': {
            'maxOutputTokens': 256,
            'temperature':     0.1,
            'thinkingConfig':  {'thinkingBudget': 0},
        },
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        cand = resp.get('candidates', [{}])[0]
        parts_out = cand.get('content', {}).get('parts', []) or []
        text = ''.join(p.get('text', '') for p in parts_out).strip()
        sys.stderr.write(f'[keywords] {os.path.basename(image_path)}: "{text[:200]}"\n')
        return text
    except Exception as e:
        sys.stderr.write(f'[keywords] error for {image_path}: {e}\n')
        return ''


# Common natural-language → price-list term expansions. Used to widen the
# keyword pool so descriptions like "self-contained" also match price-list
# entries that say "single-point" or "self contained".
KEYWORD_EXPANSIONS: dict[str, list[str]] = {
    'self-contained': ['self', 'contained', 'single', 'point', 'sp'],
    'selfcontained':  ['self', 'contained', 'single', 'point', 'sp'],
    'central':        ['central', 'battery', 'cps', 'cgline', 'zb'],
    'maintained':     ['maintained', 'cg', 'm'],
    'non-maintained': ['non', 'maintained', 'nm'],
    'suspended':      ['suspended', 'pendant', 'wire', 'wires', 'rope', 'kit'],
    'wire':           ['suspended', 'wires', 'pendant', 'kit'],
    'mall':           ['retail', 'commercial', 'public'],
    'exit':           ['exit', 'sign', 'pictogram', 'escape'],
    'sign':           ['sign', 'exit', 'pictogram'],
    'emergency':      ['emergency', 'escape', 'safety'],
    'escape':         ['escape', 'anti-panic', 'route'],
    'antipanic':      ['anti-panic', 'antipanic', 'open'],
    'anti-panic':     ['anti-panic', 'antipanic', 'open'],
    'wall':           ['wall', 'mounting'],
    'ceiling':        ['ceiling', 'surface', 'recessed'],
    'recessed':       ['recessed', 'flush', 'ceiling'],
    'outdoor':        ['outdoor', 'ip65', 'ip67', 'weatherproof'],
    'long':           ['long', 'pendant', 'suspended', 'rope', 'wire'],
    'drop':           ['suspended', 'drop', 'pendant'],
    'slim':           ['slim', 'thin'],
    'aluminum':       ['aluminium', 'metal'],
    'aluminium':      ['aluminium', 'metal'],
}


def keyword_pool(text: str, entries: list[dict], n: int = 40) -> list[dict]:
    """Score every price-list entry against expanded keywords from `text`,
    return the top `n` candidates. Used to give Gemini a constrained pool to
    choose from so it cannot hallucinate catalogue numbers."""
    if not text or not entries:
        return []
    text_lower = text.lower()
    base_words = [w for w in re.split(r'[\s\-_/,\.;:()]+', text_lower) if len(w) >= 3]
    if not base_words:
        return []

    expanded: set[str] = set()
    for w in base_words:
        expanded.add(w)
        for boost in KEYWORD_EXPANSIONS.get(w, []):
            expanded.add(boost.lower())
    # Also strip hyphens to catch "self-contained" → "selfcontained"
    expanded.update({w.replace('-', '') for w in expanded if '-' in w})

    scored: list[tuple[int, dict]] = []
    for entry in entries:
        combined = (
            (entry.get('description', '') or '') + ' ' +
            (entry.get('family', '') or '')      + ' ' +
            (entry.get('cat_no', '') or '')
        ).lower()
        if not combined.strip():
            continue
        score = 0
        for w in expanded:
            if w in combined:
                score += 1
        # Prefer Active over Discontinued
        status = (entry.get('status') or '').lower()
        if 'active' in status:
            score += 1
        elif 'discontinued' in status or 'obsolete' in status:
            score -= 2
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:n]]


def rerank_pricelist_candidates(
    description: str,
    image_paths: list[str],
    entries: list[dict],
    api_key: str,
    pool_size: int = 40,
) -> list[dict]:
    """Grounded candidate search: Gemini may ONLY pick catalogue numbers from
    a pool drawn from the actual price list. This prevents hallucination.

    Pipeline:
      1. Derive extra keywords from each image (Gemini visual description, no cat-nos).
      2. Combine description + image keywords to keyword-filter the price list
         down to `pool_size` candidates.
      3. Send the pool + description + image(s) back to Gemini, ask it to rank
         the top 6 with confidence + reasoning.
      4. Map each pick back to the real price-list entry. Any pick whose cat_no
         isn't in the pool is dropped.
    """
    import mimetypes

    has_image = bool(image_paths)
    has_text  = bool((description or '').strip())
    if not has_image and not has_text:
        return []

    # ── Step 1: image keywords (skip if no images) ────────────────────────────
    image_keywords_parts: list[str] = []
    if has_image and api_key:
        for p in image_paths:
            kw = derive_image_keywords(p, api_key)
            if kw:
                image_keywords_parts.append(kw)
    combined_keywords = ' '.join([description or '', *image_keywords_parts]).strip()

    # ── Step 2: pool from the actual price list ───────────────────────────────
    pool = keyword_pool(combined_keywords, entries, pool_size)
    sys.stderr.write(f'[rerank] keyword pool size = {len(pool)} from "{combined_keywords[:120]}"\n')
    if not pool:
        return []

    # ── Step 3: rerank with Gemini, grounded in the pool ──────────────────────
    pool_lines: list[str] = []
    for i, e in enumerate(pool):
        desc = (e.get('description') or '')[:140]
        fam  = (e.get('family') or '')[:60]
        ntp  = e.get('ntp') or 0
        st   = (e.get('status') or '')[:20]
        pool_lines.append(f'{i+1}. cat_no="{e["cat_no"]}" family="{fam}" desc="{desc}" ntp={ntp:.2f} status="{st}"')

    parts: list[dict] = []
    for img_path in image_paths or []:
        if not os.path.exists(img_path):
            continue
        try:
            mime_type = mimetypes.guess_type(img_path)[0] or 'image/png'
            with open(img_path, 'rb') as f:
                img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')
            parts.append({'inline_data': {'mime_type': mime_type, 'data': img_b64}})
        except Exception as e:
            sys.stderr.write(f'[rerank] could not load image {img_path}: {e}\n')

    prompt_lines = [
        'You are an Eaton / Cooper emergency lighting product specialist.',
        '',
        'CRITICAL CONSTRAINT — you MUST pick catalogue numbers ONLY from the candidate pool below.',
        'DO NOT invent, guess, or pull catalogue numbers from outside this pool.',
        'If nothing in the pool fits well, return an empty array.',
        '',
    ]
    if has_text:
        prompt_lines += [
            'CUSTOMER DESCRIPTION / REQUIREMENTS:',
            '"""',
            description.strip(),
            '"""',
            '',
        ]
    if image_keywords_parts:
        prompt_lines += [
            'KEYWORDS DERIVED FROM ATTACHED IMAGE(S):',
            ' · '.join(image_keywords_parts),
            '',
        ]
    if has_image:
        prompt_lines.append('You are also shown the attached image(s). Reason over visual cues + description.')
        prompt_lines.append('')
    prompt_lines += [
        f'CANDIDATE POOL (drawn from the Eaton EL price list — {len(pool)} entries):',
        *pool_lines,
        '',
        'TASK: Pick the TOP 6 best matches from the pool above, ranked by overall fit.',
        'You MUST use cat_no values that appear EXACTLY in the pool, including punctuation and spacing.',
        '',
        'Return ONLY a JSON array (no markdown, no prose):',
        '[',
        '  {',
        '    "cat_no":     "<exact cat_no copied verbatim from the pool>",',
        '    "confidence": "high" | "medium" | "low",',
        '    "reasoning":  "<one short sentence quoting which description / image cues led to this pick>"',
        '  }',
        ']',
    ]
    parts.append({'text': '\n'.join(prompt_lines)})

    payload = json.dumps({
        'contents': [{'parts': parts}],
        'generationConfig': {
            'maxOutputTokens': 4096,
            'temperature':     0.2,
            'thinkingConfig':  {'thinkingBudget': 0},
        },
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        cand = resp.get('candidates', [{}])[0]
        parts_out = cand.get('content', {}).get('parts', []) or []
        text = ''.join(p.get('text', '') for p in parts_out).strip()
        sys.stderr.write(f'[rerank] finish={cand.get("finishReason","")} parts={len(parts_out)} len={len(text)}\n')
        sys.stderr.write(f'[rerank] preview: {text[:400]}\n')
        picks = parse_gemini_items(text)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[rerank] Gemini API error {e.code}: {body[:300]}\n')
        return []
    except Exception as e:
        sys.stderr.write(f'[rerank] error: {e}\n')
        return []

    # ── Step 4: map picks back to real price-list entries ────────────────────
    pool_by_cat = {(e.get('cat_no') or ''): e for e in pool}
    pool_by_cat_norm = {(e.get('cat_no') or '').upper().replace(' ', '').replace('-', ''): e for e in pool}

    results: list[dict] = []
    for p in picks:
        cat = str(p.get('cat_no', '') or '').strip()
        if not cat:
            continue
        entry = pool_by_cat.get(cat) or pool_by_cat_norm.get(cat.upper().replace(' ', '').replace('-', ''))
        if not entry:
            sys.stderr.write(f'[rerank] dropped hallucinated cat_no "{cat}" — not in pool\n')
            continue
        results.append({
            'cat_no':      entry['cat_no'],
            'family':      entry.get('family', ''),
            'description': entry.get('description', ''),
            'list_price':  entry.get('list_price'),
            'ntp':         entry.get('ntp'),
            'status':      entry.get('status', ''),
            'confidence':  str(p.get('confidence', 'medium')).lower(),
            'reasoning':   str(p.get('reasoning', '')),
            'source_url':  '',
            'matched':     True,
        })

    return results


def identify_from_description_and_images(
    description: str,
    image_paths: list[str],
    api_key: str,
) -> list[dict]:
    """Combined multimodal candidate search.

    Sends ANY available description text together with ANY available image(s)
    in a single Gemini + Google Search call so the model can reason over both
    signals at once. Returns up to 6 ranked candidates."""
    import mimetypes
    parts: list[dict] = []

    for img_path in image_paths or []:
        if not os.path.exists(img_path):
            continue
        try:
            mime_type = mimetypes.guess_type(img_path)[0] or 'image/png'
            with open(img_path, 'rb') as f:
                img_b64 = base64.standard_b64encode(f.read()).decode('utf-8')
            parts.append({'inline_data': {'mime_type': mime_type, 'data': img_b64}})
        except Exception as e:
            sys.stderr.write(f'[combined] could not load image {img_path}: {e}\n')

    has_image = any(p for p in parts if 'inline_data' in p)
    has_text  = bool((description or '').strip())
    if not has_image and not has_text:
        return []

    prompt_lines = [
        'You are an Eaton / Cooper emergency lighting product specialist with access to Google Search.',
        '',
        'CRITICAL: Eaton acquired Cooper Industries — Cooper Safety, Menvier, Ceag, Merel, Exloc, '
        'Crouse-Hinds are ALL Eaton-group brands. Always include them as Eaton products.',
        '',
    ]
    if has_text:
        prompt_lines += [
            'CUSTOMER DESCRIPTION / REQUIREMENTS (treat as the source of truth for intent):',
            '"""',
            description.strip(),
            '"""',
            '',
            'Parse the description for: product family hints (exit sign, escape route, anti-panic, '
            'wall, ceiling, recessed, surface, suspended, IP rating, lumen output, central battery vs '
            'self-contained, maintained vs non-maintained), mounting style, drop / suspension length, '
            'environment (mall, warehouse, hospital, outdoor), and any quantities ("5 no.", "x 4").',
            '',
        ]
    if has_image:
        prompt_lines += [
            ('You are also shown one or more photographs / drawings. Reason over BOTH the description '
             'and the image(s).') if has_text else
            ('You are shown one or more photographs / drawings of an emergency lighting product. '
             'Reason purely over the image(s).'),
            'Look at: shape, housing, lens, pictogram, mounting, branding marks, dimensions.',
            '',
        ]
    prompt_lines += [
        'Use Google Search to ground candidate Eaton/Cooper catalogue numbers. Return the TOP 6 most '
        'likely candidates, ranked by overall fit (description + visual). Do not over-filter by family — '
        'include any Eaton-group EL family whose product fits.',
        '',
        'Return ONLY a JSON array (no markdown, no prose):',
        '[',
        '  {',
        '    "cat_no":      "<full Eaton/Cooper catalogue number>",',
        '    "family":      "<product family name>",',
        '    "description": "<short product description>",',
        '    "confidence":  "high" | "medium" | "low",',
        '    "reasoning":   "<one sentence: which parts of the description and/or image led to this match>",',
        '    "source_url":  "<Eaton/datasheet/distributor URL you grounded on, or empty>"',
        '  }',
        ']',
    ]
    parts.append({'text': '\n'.join(prompt_lines)})

    payload = json.dumps({
        'contents': [{'parts': parts}],
        'tools': [{'google_search': {}}],
        'generationConfig': {
            'maxOutputTokens': 8192,
            'temperature':     0.3,
            # Disable thinking — 2.5-flash thinking tokens eat the output budget,
            # which was truncating responses to ~200 chars before the JSON closed.
            'thinkingConfig':  {'thinkingBudget': 0},
        },
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        cand = resp.get('candidates', [{}])[0]
        finish = cand.get('finishReason', '')
        # Concatenate every text part — grounding may split the response.
        parts_out = cand.get('content', {}).get('parts', []) or []
        text = ''.join(p.get('text', '') for p in parts_out).strip()
        sys.stderr.write(f'[combined] finish={finish} parts={len(parts_out)} len={len(text)}\n')
        sys.stderr.write(f'[combined] preview: {text[:400]}\n')
        parsed = parse_gemini_items(text)
        return [c for c in parsed if isinstance(c, dict) and c.get('cat_no')]
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[combined] Gemini API error {e.code}: {body[:300]}\n')
        return []
    except Exception as e:
        sys.stderr.write(f'[combined] error: {e}\n')
        return []


def parse_quantity_from_text(text: str) -> int:
    """Pull a quantity from natural-language hints: '5 no.', 'x 4', 'quantity: 12', '12 off'."""
    if not text:
        return 1
    patterns = [
        r'(\d+)\s*(?:no\.?|nr\.?|off|pcs?|pieces?|qty|units?)\b',
        r'(?:qty|quantity|amount)\s*[:=]?\s*(\d+)',
        r'\bx\s*(\d+)\b',
        r'(\d+)\s*x\b',
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            try:
                v = int(m.group(1))
                if 1 <= v <= 9999:
                    return v
            except Exception:
                pass
    return 1


def looks_like_cat_no(text: str) -> bool:
    """Return True if text appears to contain an explicit Eaton-style catalogue number."""
    if not text:
        return False
    # Cat-no like: MP2ES230CGS, NXL100, LUM22216, IP65OCGS, AT-S+ 24V, 4007135xxx, etc.
    return bool(re.search(r'\b[A-Z][A-Z0-9][A-Z0-9\-\.\+/]{3,}\b', text)) \
        or bool(re.search(r'\b\d{8,}\b', text))


def extract_from_pdf(pdf_path: str, api_key: str) -> list[dict]:
    """Use Gemini vision to extract EL items from a PDF schematic."""
    sys.stderr.write(f'[pdf] extracting from {pdf_path} via Gemini\n')

    with open(pdf_path, 'rb') as f:
        pdf_b64 = base64.standard_b64encode(f.read()).decode('utf-8')

    prompt = (
        'You are an expert in Eaton and Cooper emergency lighting products.\n\n'
        'CRITICAL: Eaton acquired Cooper Industries, so Cooper Safety, Menvier, Ceag, Merel, '
        'Exloc, and all Cooper brands are Eaton products. ALWAYS include them.\n\n'
        'Extract EVERY emergency lighting item from this document that belongs to Eaton '
        'or any Eaton-group brand (Cooper Safety, Menvier, Ceag, Merel, Exloc, etc.).\n\n'
        'Return ONLY a JSON array. Each item:\n'
        '{"cat_no": "...", "description": "...", "qty": <number>, "ref": "..."}\n\n'
        'Eaton/Cooper EL families: ' + ', '.join(EL_FAMILIES) + '\n\n'
        'Catalogue number formats: MP2ES230CGS, NXL100, LUM22216, 40071354592, and Cooper formats.\n\n'
        'RULES — follow strictly:\n'
        '- A line saying "Cooper" with a catalogue number → INCLUDE IT\n'
        '- A line with an Eaton catalogue number format even without the brand name → INCLUDE IT\n'
        '- If uncertain whether an item is Eaton/Cooper → INCLUDE IT; do NOT skip it\n'
        '- If schematic: extract circuit refs (E1, EM1, EX1 …) and luminaire type\n'
        '- If BOM/material list: extract every line with its quantity\n'
        '- Combine duplicate catalogue numbers by summing quantities\n'
        '- Quantity defaults to 1 if not shown\n'
        '- i-P65 products: the full catalogue number includes mount/variant code. '
        '  If you see text like "i-P65 O CG-S" or "i-P65/0/CG-S", the O/0 is a variant — '
        '  include it exactly as written in cat_no (e.g. "IP65OCGS" or "I-P65-O-CG-S")\n'
        '- For i-P65, also try: IP65LED...CGS, IP65LEDCGS, IP65CGNM patterns\n\n'
        'Be EXHAUSTIVE. It is better to include a doubtful item than to miss a real one.\n'
        'Return ONLY the JSON array, no markdown, no explanation.'
    )

    payload = json.dumps({
        'contents': [{
            'parts': [
                {
                    'inline_data': {
                        'mime_type': 'application/pdf',
                        'data': pdf_b64,
                    }
                },
                {'text': prompt}
            ]
        }],
        'generationConfig': {
            'maxOutputTokens': 4096,
            'temperature': 0.1,
        }
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')

    try:
        with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        text = resp['candidates'][0]['content']['parts'][0]['text'].strip()
        sys.stderr.write(f'[pdf] Gemini response: {text[:200]}\n')

        return parse_gemini_items(text)

    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[pdf] Gemini API error {e.code}: {body[:300]}\n')
        raise RuntimeError(f'Gemini API error {e.code}: {body[:300]}')
    except Exception as e:
        sys.stderr.write(f'[pdf] extraction error: {e}\n')
        raise RuntimeError(f'PDF extraction failed: {e}')


def verify_unmatched_items(unmatched_raw: list[dict], lookup: dict, api_key: str) -> list[dict]:
    """Second-pass: use Gemini with Google Search to resolve items not found in the price list."""
    if not unmatched_raw:
        return []

    item_lines = '\n'.join(
        f'{i+1}. cat_no="{it.get("cat_no","")}", desc="{it.get("description","")}", ref="{it.get("ref","")}"'
        for i, it in enumerate(unmatched_raw)
    )

    prompt = (
        'You are an Eaton emergency lighting product specialist with access to Google Search.\n\n'
        'The following items were extracted from a schematic or BOM but could NOT be matched '
        'in our Eaton EL price list. The "cat_no" field may actually be a description or family name '
        'rather than a real catalogue number — treat it that way if it looks like one '
        '(e.g. "CRYSTALWAY" is an Eaton product family, "Key Test Switch" is a description).\n\n'
        f'{item_lines}\n\n'
        'For EACH item:\n'
        '1. Determine whether "cat_no" is a real part number or a description/family name\n'
        '2. Use Google Search to find the correct, current Eaton catalogue number for the product\n'
        '   - If cat_no looks like a description, search for it as a product description\n'
        '   - If cat_no looks like a part number, it may be mis-read (e.g. digit 0 vs letter O) — '
        'search for the correct version\n'
        '3. Confirm whether it is an Eaton (or Cooper/Menvier/Ceag) product\n'
        '4. Provide a brief note explaining what the product is\n\n'
        'Return a JSON array — one entry per input item:\n'
        '[{"original_cat_no":"...","confirmed_cat_no":"...","is_eaton":true,"description":"...","notes":"..."}]\n'
        'Return ONLY the JSON array.'
    )

    payload = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'tools': [{'google_search': {}}],
        'generationConfig': {'maxOutputTokens': 2048, 'temperature': 0.2},
    }).encode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as r:
            resp = json.loads(r.read())
        text = resp['candidates'][0]['content']['parts'][0]['text'].strip()
        sys.stderr.write(f'[verify] Gemini search response: {text[:300]}\n')
        suggestions = parse_gemini_items(text)

        results = []
        for s in suggestions:
            if not isinstance(s, dict):
                continue
            confirmed = str(s.get('confirmed_cat_no') or '').strip()
            original  = str(s.get('original_cat_no')  or '').strip()
            is_eaton  = bool(s.get('is_eaton', True))
            notes     = str(s.get('notes') or s.get('description') or '')

            # Try to match the confirmed cat_no first, then fall back to original
            match = match_item(confirmed, lookup) if confirmed else None
            if not match and original:
                match = match_item(original, lookup)

            results.append({
                'original_cat_no':  original,
                'confirmed_cat_no': confirmed,
                'match':            match,
                'is_eaton':         is_eaton,
                'notes':            notes,
            })
        return results
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.stderr.write(f'[verify] Gemini API error {e.code}: {body[:200]}\n')
        return []
    except Exception as e:
        sys.stderr.write(f'[verify] error: {e}\n')
        return []


def parse_material_list(text: str) -> list[dict]:
    """Parse a raw material list (pasted text / CSV / line-by-line) into items."""
    items = []
    lines = text.strip().splitlines()

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue

        # Try CSV / tab-separated: cat_no, qty, description OR qty, cat_no
        parts = re.split(r'[\t,;|]', line)
        parts = [p.strip() for p in parts if p.strip()]

        cat_no = ''
        qty    = 1
        desc   = ''
        ref    = ''

        if len(parts) >= 2:
            # Detect which column is the cat number (alphanumeric, may have hyphens)
            for p in parts:
                if re.match(r'^[A-Z0-9][A-Z0-9\-\.]{2,}$', p, re.I) and not p.isdigit():
                    cat_no = p
                    break
            # Detect qty (pure number, small value)
            for p in parts:
                try:
                    v = int(float(p))
                    if 1 <= v <= 999 and p != cat_no:
                        qty = v
                        break
                except Exception:
                    pass
            # Rest is description
            used = {cat_no, str(qty)}
            desc = ' '.join(p for p in parts if p not in used)
        else:
            # Single column — might be "MP2ES230CGS x4" or "4 x MP2ES230CGS"
            m = re.search(r'(\d+)\s*[xX]\s*([A-Z0-9][A-Z0-9\-\.]{2,})', line, re.I)
            if not m:
                m = re.search(r'([A-Z0-9][A-Z0-9\-\.]{2,})\s*[xX]\s*(\d+)', line, re.I)
            if m:
                cat_no = m.group(2) if m.group(1).isdigit() else m.group(1)
                qty    = int(m.group(1)) if m.group(1).isdigit() else int(m.group(2))
            else:
                cat_no = line.split()[0] if line.split() else line
                desc   = ' '.join(line.split()[1:])

        if cat_no:
            items.append({'cat_no': cat_no, 'description': desc, 'qty': qty, 'ref': ref})

    return items


def find_closest_matches(cat_no: str, desc: str, entries: list, n: int = 4) -> list:
    """Return up to n closest catalogue entries for an unmatched item (for UI suggestions)."""
    search_text = (cat_no + ' ' + desc).lower().strip()
    words = [w for w in re.split(r'[\s\-_/]+', search_text) if len(w) >= 3]
    if not words:
        return []
    scored = []
    for entry in entries:
        combined = (
            (entry.get('description', '') or '') + ' ' +
            (entry.get('family', '') or '') + ' ' +
            (entry.get('cat_no', '') or '')
        ).lower()
        score = sum(1 for w in words if w in combined)
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda x: -x[0])
    seen, result = set(), []
    for _, entry in scored:
        cat = entry.get('cat_no', '')
        if cat not in seen:
            seen.add(cat)
            result.append({
                'cat_no':      cat,
                'description': entry.get('description', ''),
                'family':      entry.get('family', ''),
                'ntp':         entry.get('ntp', 0.0),
                'list_price':  entry.get('list_price', 0.0),
            })
            if len(result) >= n:
                break
    return result


def price_items(raw_items: list[dict], lookup: dict, entries: list[dict]) -> dict:
    """Match raw items against the price list and return structured results."""
    priced    = []
    unmatched = []
    total_ntp = 0.0

    for item in raw_items:
        cat_no = str(item.get('cat_no', '')).strip()
        qty    = max(1, int(item.get('qty') or 1))
        ref    = str(item.get('ref', '') or '')
        desc   = str(item.get('description', '') or '')

        match, mtype = match_item_with_type(cat_no, lookup) if cat_no else (None, '')

        # If cat_no lookup failed, try searching by description/family in the sheet
        if not match and cat_no:
            search_text = cat_no + (' ' + desc if desc else '')
            match, mtype = match_by_description(search_text, entries)
            if match:
                sys.stderr.write(f'[price] description match: "{cat_no}" → {match["cat_no"]}\n')

        if match:
            line_ntp  = round(match['ntp'] * qty, 4)
            total_ntp += line_ntp
            priced.append({
                'ref':         ref,
                'cat_no':      match['cat_no'],
                'description': match['description'],
                'family':      match['family'],
                'qty':         qty,
                'list_price':  match['list_price'],
                'ntp':         match['ntp'],
                'line_ntp':    line_ntp,
                'status':      match['status'],
                'matched':     True,
                'match_type':  mtype,
                'original_input': cat_no if mtype != 'exact' else '',
            })
        else:
            closest = find_closest_matches(cat_no, desc, entries)
            priced.append({
                'ref':             ref,
                'cat_no':          cat_no,
                'description':     desc,
                'family':          '',
                'qty':             qty,
                'list_price':      0.0,
                'ntp':             0.0,
                'line_ntp':        0.0,
                'status':          'Not found',
                'matched':         False,
                'match_type':      '',
                'original_input':  cat_no,
                'closest_matches': closest,
            })
            unmatched.append(cat_no)

    return {
        'items':      priced,
        'unmatched':  unmatched,
        'total_ntp':  round(total_ntp, 2),
    }


def run_unified(manifest_path: str, lookup: dict, entries: list, api_key: str) -> dict:
    """Process a unified manifest: free text + N attachments (PDFs and/or images).

    Manifest JSON shape:
        {
          "text": "5 no. Eaton wire suspended exit signs for a mall...",
          "files": [
            {"path": "/tmp/exit.jpg", "kind": "image", "name": "exit.jpg"},
            {"path": "/tmp/schematic.pdf", "kind": "pdf",   "name": "schematic.pdf"}
          ]
        }
    """
    try:
        manifest = json.loads(open(manifest_path, encoding='utf-8').read())
    except Exception as e:
        return {'error': f'Could not read manifest: {e}', 'items': [], 'total_ntp': 0}

    text  = str(manifest.get('text') or '').strip()
    files = manifest.get('files') or []

    pdf_paths   = [str(f['path']) for f in files if f.get('kind') == 'pdf'   and os.path.exists(str(f.get('path', '')))]
    image_paths = [str(f['path']) for f in files if f.get('kind') == 'image' and os.path.exists(str(f.get('path', '')))]

    # ── Stage 1: extract explicit items from every signal ──────────────────────
    raw_items: list[dict] = []

    # 1a — text: parse only if it looks like a structured list
    text_has_catno = looks_like_cat_no(text) if text else False
    if text and text_has_catno:
        try:
            raw_items.extend(parse_material_list(text))
        except Exception as e:
            sys.stderr.write(f'[unified] text parse error: {e}\n')

    # 1b — PDFs
    for p in pdf_paths:
        if not api_key:
            sys.stderr.write('[unified] skipping PDF extraction (no Gemini key)\n')
            break
        try:
            raw_items.extend(extract_from_pdf(p, api_key))
        except Exception as e:
            sys.stderr.write(f'[unified] PDF extract failed for {p}: {e}\n')

    # 1c — images
    for p in image_paths:
        if not api_key:
            sys.stderr.write('[unified] skipping image extraction (no Gemini key)\n')
            break
        try:
            raw_items.extend(extract_from_image(p, api_key))
        except Exception as e:
            sys.stderr.write(f'[unified] image extract failed for {p}: {e}\n')

    # ── Stage 2: price every extracted item against the price list ────────────
    result = price_items(raw_items, lookup, entries) if raw_items else {
        'items': [], 'unmatched': [], 'total_ntp': 0.0,
    }

    # ── Stage 3: search verification for unmatched items ──────────────────────
    if api_key and result.get('unmatched'):
        unmatched_set = set(result['unmatched'])
        unmatched_raw = [it for it in raw_items if str(it.get('cat_no', '')).strip() in unmatched_set]
        try:
            suggestions = verify_unmatched_items(unmatched_raw, lookup, api_key)
            for s in suggestions:
                orig  = s.get('original_cat_no', '')
                match = s.get('match')
                if match and s.get('is_eaton', True):
                    for item in result['items']:
                        if item.get('cat_no') == orig and not item.get('matched'):
                            qty      = item['qty']
                            line_ntp = round(match['ntp'] * qty, 4)
                            item.update({
                                'cat_no':      match['cat_no'],
                                'description': match['description'],
                                'family':      match['family'],
                                'list_price':  match['list_price'],
                                'ntp':         match['ntp'],
                                'line_ntp':    line_ntp,
                                'status':      match['status'],
                                'matched':     True,
                                'search_note': s.get('notes', ''),
                            })
                            result['total_ntp'] = round(result['total_ntp'] + line_ntp, 2)
                            if orig in result['unmatched']:
                                result['unmatched'].remove(orig)
                            break
                elif not s.get('is_eaton', True):
                    for item in result['items']:
                        if item.get('cat_no') == orig and not item.get('matched'):
                            item['status'] = 'Non-Eaton'
                            item['search_note'] = s.get('notes', 'Confirmed non-Eaton product')
                            break
        except Exception as e:
            sys.stderr.write(f'[unified] verify pass error: {e}\n')

    # ── Stage 4: combined multimodal candidate search ─────────────────────────
    # Triggered when ANY of:
    #   - user gave descriptive text without an explicit cat-no
    #   - any image was attached (always offer visual candidates)
    #   - items remain unmatched after stages 2+3
    needs_candidates = bool(
        (text and not text_has_catno)
        or image_paths
        or result.get('unmatched')
    )
    candidates: list[dict] = []
    queries:    list[dict] = []
    if needs_candidates and api_key:
        desc_qty = parse_quantity_from_text(text) if text else 1

        # ── Per-item grouping when image(s) are attached ───────────────────
        # Ask Gemini to enumerate distinct items in EACH image, then run the
        # grounded reranker once per item. This produces queries[] grouped by
        # detected item so the UI can show "Item 1 → these candidates,
        # Item 2 → these candidates" instead of one flat blob.
        item_queries: list[dict] = []
        if image_paths:
            for img_path in image_paths:
                try:
                    items = describe_items_in_image(img_path, api_key)
                except Exception as e:
                    sys.stderr.write(f'[unified] describe_items_in_image failed: {e}\n')
                    items = []
                for i, item in enumerate(items):
                    label = item.get('label') or f'Item {i+1}'
                    kws   = item.get('keywords') or ''
                    item_text = ' '.join([label, kws, text or '']).strip()
                    qty = item.get('qty') or desc_qty or 1
                    try:
                        per_item = rerank_pricelist_candidates(item_text, [img_path], entries, api_key)
                    except Exception as e:
                        sys.stderr.write(f'[unified] per-item rerank failed: {e}\n')
                        per_item = []
                    item_queries.append({
                        'id':         f'{os.path.basename(img_path)}#item-{i+1}',
                        'label':      label,
                        'keywords':   kws,
                        'qty':        qty,
                        'candidates': [{
                            'cat_no':        c['cat_no'],
                            'family':        c.get('family', ''),
                            'description':   c.get('description', ''),
                            'confidence':    c.get('confidence', 'medium'),
                            'reasoning':     c.get('reasoning', ''),
                            'source_url':    c.get('source_url', ''),
                            'matched':       True,
                            'list_price':    c.get('list_price'),
                            'ntp':           c.get('ntp'),
                            'status':        c.get('status'),
                            'suggested_qty': qty,
                        } for c in per_item],
                    })

        queries = item_queries

        # ── Description-driven fallback (always run when there's text) ─────
        # Returned as a global `candidates` list. The UI shows this under a
        # "From description" group when no per-item queries were produced.
        try:
            raw_candidates = rerank_pricelist_candidates(text, image_paths, entries, api_key)
        except Exception as e:
            sys.stderr.write(f'[unified] grounded candidate search failed: {e}\n')
            raw_candidates = []
        for c in raw_candidates:
            candidates.append({
                'cat_no':        c['cat_no'],
                'family':        c.get('family', ''),
                'description':   c.get('description', ''),
                'confidence':    c.get('confidence', 'medium'),
                'reasoning':     c.get('reasoning', ''),
                'source_url':    c.get('source_url', ''),
                'matched':       True,
                'list_price':    c.get('list_price'),
                'ntp':           c.get('ntp'),
                'status':        c.get('status'),
                'suggested_qty': desc_qty,
            })

    result['candidates']       = candidates
    result['queries']          = queries
    result['source']           = 'unified'
    result['extracted_count']  = len(raw_items)
    result['inputs'] = {
        'has_text':    bool(text),
        'pdf_count':   len(pdf_paths),
        'image_count': len(image_paths),
        'qty_hint':    parse_quantity_from_text(text) if text else 1,
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['pdf', 'list', 'image', 'unified'], required=True)
    parser.add_argument('--input', required=True, help='Path for pdf/image/list-text/unified-manifest')
    args = parser.parse_args()

    lookup, entries = load_pricelist()
    if not lookup:
        print(json.dumps({'error': 'Price list not found or failed to load'}))
        sys.exit(1)

    cfg     = load_config()
    api_key = cfg.get('gemini_key') or os.environ.get('GEMINI_API_KEY', '')

    # ── Unified mode: single JSON manifest combining text + N attachments ─────
    if args.mode == 'unified':
        result = run_unified(args.input, lookup, entries, api_key)
        print(json.dumps(result))
        return

    if args.mode in ('pdf', 'image'):
        if not api_key:
            print(json.dumps({'error': 'No Gemini API key — add gemini_key in Settings'}))
            sys.exit(1)
        try:
            raw_items = (extract_from_pdf if args.mode == 'pdf' else extract_from_image)(args.input, api_key)
        except RuntimeError as e:
            print(json.dumps({'error': str(e), 'items': [], 'total_ntp': 0}))
            sys.exit(1)
        source = args.mode
    else:
        # --input is a file path containing the material list text
        if os.path.exists(args.input):
            text = open(args.input, encoding='utf-8').read()
        else:
            text = args.input  # fallback: treat as raw text
        raw_items = parse_material_list(text)
        source = 'list'

    if not raw_items:
        print(json.dumps({'error': 'No items extracted', 'items': [], 'total_ntp': 0}))
        sys.exit(1)

    result = price_items(raw_items, lookup, entries)

    # ── Second pass: use Gemini + Google Search to resolve unmatched items ────
    if api_key and result.get('unmatched'):
        unmatched_set = set(result['unmatched'])
        unmatched_raw = [it for it in raw_items if str(it.get('cat_no', '')).strip() in unmatched_set]
        sys.stderr.write(f'[main] running search verification for {len(unmatched_raw)} unmatched item(s)\n')
        suggestions = verify_unmatched_items(unmatched_raw, lookup, api_key)

        for s in suggestions:
            orig  = s.get('original_cat_no', '')
            match = s.get('match')
            if match and s.get('is_eaton', True):
                # Update the unmatched item in the result list with the found data
                for item in result['items']:
                    if item.get('cat_no') == orig and not item.get('matched'):
                        qty      = item['qty']
                        line_ntp = round(match['ntp'] * qty, 4)
                        item.update({
                            'cat_no':      match['cat_no'],
                            'description': match['description'],
                            'family':      match['family'],
                            'list_price':  match['list_price'],
                            'ntp':         match['ntp'],
                            'line_ntp':    line_ntp,
                            'status':      match['status'],
                            'matched':     True,
                            'search_note': s.get('notes', ''),
                        })
                        result['total_ntp'] = round(result['total_ntp'] + line_ntp, 2)
                        if orig in result['unmatched']:
                            result['unmatched'].remove(orig)
                        break
            elif not s.get('is_eaton', True):
                # Confirmed non-Eaton — label it so the UI can show why it's excluded
                for item in result['items']:
                    if item.get('cat_no') == orig and not item.get('matched'):
                        item['status'] = 'Non-Eaton'
                        item['search_note'] = s.get('notes', 'Confirmed non-Eaton product')
                        break

    # ── Image-only third pass: visual product identification via Google Search ─
    # Runs for every image so the UI can offer the user a chooser of likely matches
    # (without overriding extracted items). No family rules — pure AI + web grounding.
    if source == 'image' and api_key:
        # Grounded reranker — picks cat-nos only from the actual price list.
        sys.stderr.write('[main] running grounded candidate rerank for image\n')
        try:
            grounded = rerank_pricelist_candidates('', [args.input], entries, api_key)
        except Exception as e:
            sys.stderr.write(f'[main] rerank failed: {e}\n')
            grounded = []
        result['candidates'] = [{
            'cat_no':        c['cat_no'],
            'family':        c.get('family', ''),
            'description':   c.get('description', ''),
            'confidence':    c.get('confidence', 'medium'),
            'reasoning':     c.get('reasoning', ''),
            'source_url':    c.get('source_url', ''),
            'matched':       True,
            'list_price':    c.get('list_price'),
            'ntp':           c.get('ntp'),
            'status':        c.get('status'),
        } for c in grounded]

    result['source']          = source
    result['extracted_count'] = len(raw_items)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
