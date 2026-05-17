import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';

export default function TrustBar() {
  const { state } = useFunnel();
  return (
    <p className="text-center font-sans text-xs text-purple-400 py-2 tracking-wide">
      {t.trust.private[state.lang]}
    </p>
  );
}
