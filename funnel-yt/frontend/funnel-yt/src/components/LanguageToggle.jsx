import { useFunnel } from '../context/FunnelContext';

export default function LanguageToggle() {
  const { state, dispatch } = useFunnel();
  const current = state.lang;

  function toggle(lang) {
    dispatch({ type: 'SET_LANG', payload: lang });
    localStorage.setItem('mhs_lang', lang);
  }

  return (
    <div className="flex items-center bg-purple-50 rounded-pill p-0.5 gap-0.5">
      <button
        onClick={() => toggle('tamil')}
        className={`px-2.5 py-1 rounded-pill text-xs font-sans font-semibold transition-all duration-200 ${
          current === 'tamil'
            ? 'bg-purple text-white shadow-sm'
            : 'text-purple-400 hover:text-purple'
        }`}
      >
        தமிழ்
      </button>
      <button
        onClick={() => toggle('english')}
        className={`px-2.5 py-1 rounded-pill text-xs font-sans font-semibold transition-all duration-200 ${
          current === 'english'
            ? 'bg-purple text-white shadow-sm'
            : 'text-purple-400 hover:text-purple'
        }`}
      >
        ENG
      </button>
    </div>
  );
}
