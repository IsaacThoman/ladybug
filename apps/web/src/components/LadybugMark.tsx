/** The flat ladybug, seen from above: the logo, and the stand-in when WebGL isn't available. */
export default function LadybugMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="ladybug-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M13 5.6 10.4 2.6M19 5.6l2.6-3" stroke="#3a211c" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="9" r="5.2" fill="#3a211c" />
      <circle cx="13.6" cy="7.6" r="1.25" fill="#f7e6cc" />
      <circle cx="18.4" cy="7.6" r="1.25" fill="#f7e6cc" />
      <ellipse cx="16" cy="19.5" rx="11" ry="10.5" fill="#e5483e" />
      <path d="M16 10v20" stroke="#3a211c" strokeWidth="1.5" />
      <circle cx="11" cy="16.5" r="2.2" fill="#3a211c" />
      <circle cx="21" cy="16.5" r="2.2" fill="#3a211c" />
      <circle cx="10.6" cy="23.2" r="1.8" fill="#3a211c" />
      <circle cx="21.4" cy="23.2" r="1.8" fill="#3a211c" />
      <ellipse cx="11.2" cy="12.6" rx="2.6" ry="1.1" fill="#fff" opacity="0.35" transform="rotate(-28 11.2 12.6)" />
    </svg>
  );
}
