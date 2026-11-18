import React from 'react';

interface BrandMarkProps {
  compact?: boolean;
}

export const WaveformSymbol: React.FC<{ className?: string }> = ({ className = '' }) => {
  const heights = [38, 68, 95, 52, 82, 44];
  return (
    <span
      className={`inline-flex items-center gap-[3px] h-5 ${className}`}
      aria-hidden="true"
    >
      {heights.map((h, idx) => (
        <span
          key={idx}
          className="waveform-bar w-[2.5px] rounded-full bg-gradient-to-t from-[#FF5500] to-[#8B5CF6]"
          style={{
            height: `${h}%`,
            animationDelay: `${idx * 0.16}s`,
          }}
        />
      ))}
    </span>
  );
};

export const BrandMark: React.FC<BrandMarkProps> = ({ compact = false }) => {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#121216] border border-white/10">
        <WaveformSymbol />
      </span>
      {!compact && (
        <span className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
          SONICPUSH <span className="text-[#FF5500]">AI</span>
        </span>
      )}
    </span>
  );
};
