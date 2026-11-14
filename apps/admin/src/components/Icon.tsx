import type { IconName } from "../format";

const PATHS: Record<IconName, string> = {
  check: "M3.5 8.5l3 3 6-7",
  alert: "M8 2.5l6 10.5H2L8 2.5zM8 6.5v3M8 11.3v.2",
  clock: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5v3.2l2 1.3",
  minus: "M4 8h8",
  globe:
    "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5",
  bell: "M4 11V7.5a4 4 0 0 1 8 0V11l1 1.3H3L4 11zM6.6 13.8a1.5 1.5 0 0 0 2.8 0",
  user: "M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8zM3 13.5c.6-2.4 2.6-3.7 5-3.7s4.4 1.3 5 3.7",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  home: "M2.5 7.3L8 2.8l5.5 4.5M4 6.2v7.3h3V10h2v3.5h3V6.2",
  pulse: "M1.8 8.5h2.6l1.6-4 3.2 8 1.6-4h3.4",
  database:
    "M8 2.5c2.8 0 5 .8 5 1.8v7.4c0 1-2.2 1.8-5 1.8s-5-.8-5-1.8V4.3c0-1 2.2-1.8 5-1.8zM3 4.3c0 1 2.2 1.8 5 1.8s5-.8 5-1.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8",
  signout: "M6.5 13.5h-3v-11h3M10 5l3 3-3 3M13 8H6.5",
};

export default function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
