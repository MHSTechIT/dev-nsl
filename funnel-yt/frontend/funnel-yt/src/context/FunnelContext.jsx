import { createContext, useContext, useReducer, useEffect } from 'react';
import { parseUTMParams } from '../utils/utm';
import { detectSource } from '../utils/source';

const FunnelContext = createContext(null);

const STATE_KEY  = 'funnel_state';
const CONFIG_KEY = 'webinar_config_cache'; // kept only for saveConfig (SSE writes fresh data here)

/* ── localStorage helpers ───────────────────────────────────────────────── */
function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(state) {
  try {
    // Persist only the fields that are worth restoring
    const { lang, sugarLevel, diabetesDuration, languageQualified,
            fullName, whatsappNumber, email,
            leadScore, submittedLeadId, whatsappGroupLink, utm } = state;
    localStorage.setItem(STATE_KEY, JSON.stringify({
      lang, sugarLevel, diabetesDuration, languageQualified,
      fullName, whatsappNumber, email,
      leadScore, submittedLeadId, whatsappGroupLink, utm,
    }));
  } catch {}
}

function saveConfig(data) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(data)); } catch {}
}

/* ── Build initial state ─────────────────────────────────────────────────── */
const savedState = loadState();

const initialState = {
  source:             detectSource(),
  lang:               savedState?.lang               ?? 'english',
  navDirection:       'forward',
  sugarLevel:         savedState?.sugarLevel         ?? null,
  diabetesDuration:   savedState?.diabetesDuration   ?? null,
  languageQualified:  savedState?.languageQualified  ?? null,
  fullName:           savedState?.fullName           ?? '',
  whatsappNumber:     savedState?.whatsappNumber     ?? '',
  email:              savedState?.email              ?? '',
  leadScore:          savedState?.leadScore          ?? null,
  submittedLeadId:    savedState?.submittedLeadId    ?? null,
  whatsappGroupLink:  savedState?.whatsappGroupLink  ?? null,
  utm:                savedState?.utm ?? { utm_source: null, utm_campaign: null, utm_content: null, fbclid: null },
  webinarConfig: {
    next_webinar_at:        null,
    backup_webinar_at:      null,
    tuesday_whatsapp_link:  null,
    friday_whatsapp_link:   null,
    kill_switch:            false,
  },
  webinarConfigLoading: true,
  webinarConfigError:   null,
};

/* ── Reducer ─────────────────────────────────────────────────────────────── */
function reducer(state, action) {
  switch (action.type) {
    case 'SET_LANG':
      return { ...state, lang: action.payload };
    case 'SET_NAV_DIRECTION':
      return { ...state, navDirection: action.payload };
    case 'SET_SUGAR_LEVEL':
      return { ...state, sugarLevel: action.payload };
    case 'SET_DURATION':
      return { ...state, diabetesDuration: action.payload };
    case 'SET_LANGUAGE_QUALIFIED':
      return { ...state, languageQualified: action.payload };
    case 'SET_FORM_FIELD':
      return { ...state, [action.field]: action.value };
    case 'SET_UTM':
      return { ...state, utm: action.payload };
    case 'SET_WEBINAR_CONFIG':
      return { ...state, webinarConfig: action.payload, webinarConfigLoading: false, webinarConfigError: null };
    case 'SET_WEBINAR_CONFIG_ERROR':
      return { ...state, webinarConfigLoading: false, webinarConfigError: action.payload };
    case 'SET_SUBMITTED':
      return {
        ...state,
        submittedLeadId:   action.payload.leadId,
        leadScore:         action.payload.leadScore,
        whatsappGroupLink: action.payload.whatsappGroupLink,
      };
    case 'RESET':
      try { localStorage.removeItem(STATE_KEY); } catch {}
      return {
        ...initialState,
        lang:                'english',
        utm:                 state.utm,
        webinarConfig:       state.webinarConfig,
        webinarConfigLoading: false,
        sugarLevel:          null,
        diabetesDuration:    null,
        languageQualified:   null,
        fullName:            '',
        whatsappNumber:      '',
        email:               '',
        leadScore:           null,
        submittedLeadId:     null,
        whatsappGroupLink:   null,
      };
    default:
      return state;
  }
}

/* ── Provider ────────────────────────────────────────────────────────────── */
export function FunnelProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Persist state to localStorage on every change
  useEffect(() => {
    saveState(state);
  }, [state]);

  // On mount: fetch config once, then listen for live updates via SSE
  useEffect(() => {
    dispatch({ type: 'SET_UTM', payload: parseUTMParams() });
    try { localStorage.removeItem(CONFIG_KEY); } catch {}

    const source = detectSource();

    fetch(`/api/webinar-config?source=${source}`)
      .then(r => r.json())
      .then(data => {
        saveConfig(data);
        dispatch({ type: 'SET_WEBINAR_CONFIG', payload: data });
      })
      .catch(err => dispatch({ type: 'SET_WEBINAR_CONFIG_ERROR', payload: err.message }));

    const es = new EventSource(`/api/webinar-config/events?source=${source}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        saveConfig(data);
        dispatch({ type: 'SET_WEBINAR_CONFIG', payload: data });
      } catch {}
    };
    return () => es.close();
  }, []);

  return (
    <FunnelContext.Provider value={{ state, dispatch }}>
      {children}
    </FunnelContext.Provider>
  );
}

export function useFunnel() {
  return useContext(FunnelContext);
}
