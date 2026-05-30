import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';

export default function ProgressBar({ step }) {
  const { state } = useFunnel();
  const lang = state.lang;
  const total = 5;

  return (
    <div className="px-4 py-3">
      <div className="flex gap-1.5 mb-2">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} className="flex-1 h-1.5 rounded-full bg-purple-100 overflow-hidden">
            {i < step && (
              <m.div
                className="h-full rounded-full"
                style={{ background: 'linear-gradient(90deg, #5B21B6, #8B6FEA)' }}
                initial={{ width: 0 }}
                animate={{ width: '100%' }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
              />
            )}
          </div>
        ))}
      </div>
      <p className="font-sans text-xs text-purple-400 text-right tracking-wide">
        {t.progress.step[lang]} <span className="text-purple font-semibold">{step}</span> {t.progress.of[lang]} {total}
      </p>
    </div>
  );
}
