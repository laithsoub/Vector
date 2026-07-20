// ─── i18n — UI language support (en / fr / de) ───────────────────────────────
import { createContext, useContext } from 'react';

export type Lang = 'en' | 'fr' | 'de';
export const LANG_LABELS: Record<Lang, string> = { en: 'English', fr: 'Français', de: 'Deutsch' };

const T = {
  en: {
    // Sidebar nav
    dashboard:  'Dashboard',
    assistant:  'Ask Vector',
    history:    'Run history',
    analytics:  'Analytics',
    inbox:      'Inbox',
    crm:        'CRM',
    elInfo:     'EL Info',
    fenton:     'Ask Fenton',
    pmo:        'Raise PMO',
    cbuSizer:   'CBU Sizer',
    commission: 'Commission',
    docPacks:   'Doc Packs',
    schematics: 'EL Pricer',
    settings:   'Settings',
    workflow:   'Workflow',
    tools:      'Tools',
    // Sidebar subtitles
    sub_dashboard:  'Drop quotes, run extractor, push to SharePoint',
    sub_assistant:  'Ask anything — paste an email and I\'ll tell you what to do',
    sub_history:   'Every job, every step, every error',
    sub_analytics: 'Throughput, success rate, customer mix',
    sub_inbox:     'Read emails, AI triage, draft and send replies',
    sub_crm:       'Account cards — contacts, quotes, AI facts, documents',
    sub_elInfo:    'EL division internal updates, files, AI digest & chat',
    sub_fenton:    "Mark Fenton's answers as a searchable AI knowledge base",
    sub_pmo:       'Fill the PMO template from a quote, PO and DOCU_ID',
    sub_cbu:        'LoadStar-PS sizing calculator',
    sub_commission: 'CG Line+ and Easicheck commissioning calculator',
    sub_docs:       'Standard Eaton documents',
    sub_schematics: 'Price Eaton EL items from schematics or material lists',
    sub_settings:  'config.json — shared with Python scripts',
    // Header / buttons
    connectJoe:    'Connect to JOE',
    connected:     'Connected',
    connecting:    'Connecting\u2026',
    language:      'Language',
    // Settings page
    settings_paths_title: 'Paths & integration',
    settings_paths_sub:   'Written to config.json — shared with Python scripts',
    settings_save:        'Save settings',
    settings_saving:      'Saving\u2026',
    settings_saved:       'Saved',
    settings_revert:      'Revert',
  },
  fr: {
    dashboard:  'Tableau de bord',
    assistant:  'Ask Vector',
    history:    'Historique',
    analytics:  'Analytique',
    inbox:      'Boîte de réception',
    crm:        'CRM',
    elInfo:     'EL Info',
    fenton:     'Ask Fenton',
    pmo:        'Lever PMO',
    cbuSizer:   'Dimensionneur CBU',
    commission: 'Commission',
    docPacks:   'Doc Packs',
    schematics: 'EL Tarificateur',
    settings:   'Param\u00e8tres',
    workflow:   'Flux de travail',
    tools:      'Outils',
    sub_dashboard: 'D\u00e9posez des devis, lancez l\u2019extracteur, envoyez vers SharePoint',
    sub_assistant:  'Posez n\'importe quelle question — collez un e-mail et je vous dirai quoi faire',
    sub_history:   'Chaque t\u00e2che, chaque \u00e9tape, chaque erreur',
    sub_analytics: 'D\u00e9bit, taux de succ\u00e8s, mix clients',
    sub_inbox:     'Lire les e-mails, tri IA, r\u00e9diger et envoyer des r\u00e9ponses',
    sub_crm:       'Fiches clients \u2014 contacts, devis, opportunit\u00e9s, faits',
    sub_elInfo:    'Mises \u00e0 jour internes EL, fichiers, synth\u00e8se IA et chat',
    sub_fenton:    'Les r\u00e9ponses de Mark Fenton en base de connaissances IA',
    sub_pmo:       'Remplir le mod\u00e8le PMO depuis un devis, BC et DOCU_ID',
    sub_cbu:        'Calculateur de dimensionnement LoadStar-PS',
    sub_commission: 'Calculateur de mise en service CG Line+ et Easicheck',
    sub_docs:       'Documents Eaton standard',
    sub_schematics:'Tarifer les produits Eaton EL depuis schémas ou listes',
    sub_settings:  'config.json \u2014 partag\u00e9 avec les scripts Python',
    connectJoe:    'Connecter \u00e0 JOE',
    connected:     'Connect\u00e9',
    connecting:    'Connexion\u2026',
    language:      'Langue',
    settings_paths_title: 'Chemins & int\u00e9gration',
    settings_paths_sub:   '\u00c9crit dans config.json \u2014 partag\u00e9 avec les scripts Python',
    settings_save:        'Enregistrer',
    settings_saving:      'Enregistrement\u2026',
    settings_saved:       'Enregistr\u00e9',
    settings_revert:      'R\u00e9initialiser',
  },
  de: {
    dashboard:  'Dashboard',
    assistant:  'Ask Vector',
    history:    'Verlauf',
    analytics:  'Analytik',
    inbox:      'Posteingang',
    crm:        'CRM',
    elInfo:     'EL Info',
    fenton:     'Ask Fenton',
    pmo:        'PMO erstellen',
    cbuSizer:   'CBU-Rechner',
    commission: 'Provision',
    docPacks:   'Dok-Pakete',
    schematics: 'EL Kalkulation',
    settings:   'Einstellungen',
    workflow:   'Arbeitsablauf',
    tools:      'Werkzeuge',
    sub_dashboard: 'Angebote einlegen, Extraktor starten, zu SharePoint hochladen',
    sub_assistant:  'Fragen Sie alles \u2014 f\u00fcgen Sie eine E-Mail ein und ich sage Ihnen, was zu tun ist',
    sub_history:   'Jeder Auftrag, jeder Schritt, jeder Fehler',
    sub_analytics: 'Durchsatz, Erfolgsquote, Kundenmix',
    sub_inbox:     'E-Mails lesen, KI-Triage, Antworten verfassen und senden',
    sub_crm:       'Kundenkarten \u2014 Kontakte, Angebote, Chancen, Fakten',
    sub_elInfo:    'Interne EL-Updates, Dateien, KI-Digest & Chat',
    sub_fenton:    'Mark Fentons Antworten als durchsuchbare KI-Wissensbasis',
    sub_pmo:       'PMO-Vorlage aus Angebot, Auftrag und DOCU_ID ausf\u00fcllen',
    sub_cbu:        'LoadStar-PS Dimensionierungsrechner',
    sub_commission: 'Inbetriebnahmerechner für CG Line+ und Easicheck',
    sub_docs:       'Standard Eaton-Dokumente',
    sub_schematics:'Eaton EL-Produkte aus Schaltplänen oder Materiallisten bepreisen',
    sub_settings:  'config.json \u2014 geteilt mit Python-Skripten',
    connectJoe:    'Mit JOE verbinden',
    connected:     'Verbunden',
    connecting:    'Verbinde\u2026',
    language:      'Sprache',
    settings_paths_title: 'Pfade & Integration',
    settings_paths_sub:   'Wird in config.json geschrieben \u2014 geteilt mit Python-Skripten',
    settings_save:        'Einstellungen speichern',
    settings_saving:      'Speichert\u2026',
    settings_saved:       'Gespeichert',
    settings_revert:      'Zur\u00fccksetzen',
  },
};

export type Translations = typeof T.en;

export interface LangCtxType {
  lang: Lang;
  t: Translations;
  setLang: (l: Lang) => void;
}

export const LangCtx = createContext<LangCtxType>({
  lang: 'en', t: T.en, setLang: () => {},
});

export function useLang() { return useContext(LangCtx); }

export { T };
