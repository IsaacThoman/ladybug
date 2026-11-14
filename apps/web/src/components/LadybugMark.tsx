export default function LadybugMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="ladybug-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M12.5 5.5 9.5 2.5M19.5 5.5l3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="9" r="5" fill="#1b1d22" stroke="currentColor" strokeOpacity="0.25" />
      <ellipse cx="16" cy="19" rx="11" ry="11" fill="var(--accent)" />
      <path d="M16 8.5V30" stroke="#1b1d22" strokeWidth="1.6" />
      <circle cx="11" cy="16" r="2.2" fill="#1b1d22" />
      <circle cx="21" cy="16" r="2.2" fill="#1b1d22" />
      <circle cx="10.5" cy="23" r="1.9" fill="#1b1d22" />
      <circle cx="21.5" cy="23" r="1.9" fill="#1b1d22" />
      <ellipse cx="11.5" cy="12" rx="2.6" ry="1.2" fill="#fff" opacity="0.28" transform="rotate(-30 11.5 12)" />
    </svg>
  );
}
