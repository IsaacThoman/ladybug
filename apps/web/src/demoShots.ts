// Hand-drawn SVG "screenshots" of a phishing kit for the offline demo. The
// brand is fictional (Northwind Bank).

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const NAVY = "#0b2a4a";
const TEAL = "#0f7c8c";

const toDataUrl = (w: number, h: number, body: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">${body}</svg>`,
  )}`;

const logo = (x: number, y: number, scale = 1, light = true) => `
  <g transform="translate(${x} ${y}) scale(${scale})">
    <circle cx="18" cy="18" r="17" fill="none" stroke="${light ? "#fff" : NAVY}" stroke-width="2.5"/>
    <path d="M18 4 L22 18 L18 32 L14 18 Z" fill="${light ? "#fff" : NAVY}"/>
    <path d="M4 18 L18 14 L32 18 L18 22 Z" fill="${TEAL}"/>
    <text x="44" y="17" font-size="17" font-weight="700" fill="${light ? "#fff" : NAVY}" letter-spacing="0.5">NORTHWIND</text>
    <text x="44" y="33" font-size="12" fill="${light ? "#a9c4dd" : TEAL}" letter-spacing="3.2">BANK</text>
  </g>`;

const field = (x: number, y: number, w: number, label: string, value = "", focused = false) => `
  <text x="${x}" y="${y}" font-size="14" font-weight="600" fill="#33475b">${label}</text>
  <rect x="${x}" y="${y + 10}" width="${w}" height="46" rx="6" fill="#fff" stroke="${focused ? TEAL : "#b8c4d0"}" stroke-width="${focused ? 2 : 1.2}"/>
  ${value ? `<text x="${x + 14}" y="${y + 40}" font-size="16" fill="#1d2b3a">${value}</text>` : ""}`;

const button = (x: number, y: number, w: number, label: string) => `
  <rect x="${x}" y="${y}" width="${w}" height="50" rx="6" fill="${TEAL}"/>
  <text x="${x + w / 2}" y="${y + 31}" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>`;

const header = (w: number, compact = false) => `
  <rect width="${w}" height="${compact ? 64 : 76}" fill="${NAVY}"/>
  ${logo(compact ? 18 : 48, compact ? 14 : 20, compact ? 0.95 : 1.1)}
  ${
    compact
      ? `<g fill="#fff"><rect x="${w - 46}" y="22" width="24" height="3" rx="1.5"/><rect x="${w - 46}" y="30" width="24" height="3" rx="1.5"/><rect x="${w - 46}" y="38" width="24" height="3" rx="1.5"/></g>`
      : `<g font-size="15" fill="#d6e3ef">
          <text x="${w - 560}" y="45">Personal</text><text x="${w - 470}" y="45">Business</text>
          <text x="${w - 375}" y="45">Wealth</text><text x="${w - 295}" y="45">Help &amp; Support</text>
        </g>
        <rect x="${w - 150}" y="24" width="104" height="32" rx="16" fill="none" stroke="#fff" stroke-opacity="0.6"/>
        <text x="${w - 98}" y="45" font-size="14" fill="#fff" text-anchor="middle">Locations</text>`
  }`;

const alertBanner = (x: number, y: number, w: number, lines: string[]) => `
  <rect x="${x}" y="${y}" width="${w}" height="${30 + lines.length * 22}" rx="6" fill="#fdecec" stroke="#e5a3a3"/>
  <circle cx="${x + 24}" cy="${y + 27}" r="10" fill="#c62828"/>
  <text x="${x + 24}" y="${y + 32}" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">!</text>
  ${lines
    .map(
      (l, i) =>
        `<text x="${x + 46}" y="${y + 32 + i * 22}" font-size="15" fill="#8e1c1c"${i === 0 ? ' font-weight="700"' : ""}>${l}</text>`,
    )
    .join("")}`;

export function shotRedirect() {
  const w = 1280;
  const h = 800;
  return toDataUrl(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#f4f6f9"/>
     <g transform="translate(${w / 2} 330)">
       <circle r="34" fill="none" stroke="#dbe2ea" stroke-width="7"/>
       <path d="M0 -34 A34 34 0 0 1 34 0" fill="none" stroke="${TEAL}" stroke-width="7" stroke-linecap="round"/>
     </g>
     <text x="${w / 2}" y="420" font-size="24" font-weight="600" fill="#1d2b3a" text-anchor="middle">Verifying your secure session…</text>
     <text x="${w / 2}" y="452" font-size="16" fill="#6b7c8f" text-anchor="middle">Please wait while we redirect you. Do not close this window.</text>
     <text x="${w / 2}" y="770" font-size="12" fill="#a0acb9" text-anchor="middle">nw-alerts.click · secure link service</text>`,
  );
}

export function shotLogin() {
  const w = 1280;
  const h = 800;
  return toDataUrl(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#eef2f6"/>
     ${header(w)}
     <rect y="76" width="${w}" height="470" fill="#dfe9f2"/>
     <path d="M0 546 L0 300 Q 320 220 640 330 T 1280 260 L1280 546 Z" fill="#cddcea"/>
     <path d="M0 546 L0 420 Q 360 330 720 430 T 1280 380 L1280 546 Z" fill="#bcd0e3"/>
     ${alertBanner(72, 118, 560, ["Unusual sign-in activity detected", "Your Online Banking access will be suspended within", "24 hours unless you verify your identity."])}
     <text x="72" y="300" font-size="40" font-weight="700" fill="${NAVY}">Banking that moves</text>
     <text x="72" y="348" font-size="40" font-weight="700" fill="${NAVY}">with you.</text>
     <text x="72" y="392" font-size="18" fill="#3c5268">Sign in to review recent activity and keep your account secure.</text>
     <rect x="760" y="110" width="440" height="540" rx="10" fill="#fff" stroke="#d3dbe4"/>
     <rect x="760" y="110" width="440" height="6" rx="3" fill="${TEAL}"/>
     <text x="796" y="168" font-size="24" font-weight="700" fill="${NAVY}">Sign in to Online Banking</text>
     <text x="796" y="196" font-size="14" fill="#6b7c8f">Secure session · 256-bit encryption</text>
     ${field(796, 232, 368, "User ID")}
     ${field(796, 322, 368, "Password")}
     <rect x="796" y="408" width="18" height="18" rx="3" fill="#fff" stroke="#9aa9b8"/>
     <text x="824" y="422" font-size="14" fill="#33475b">Remember my User ID</text>
     ${button(796, 448, 368, "Verify &amp; Sign in")}
     <text x="796" y="540" font-size="14" fill="${TEAL}" font-weight="600">Forgot User ID or Password?</text>
     <text x="796" y="568" font-size="14" fill="${TEAL}" font-weight="600">Enroll in Online Banking</text>
     <path d="M796 600 h368" stroke="#e3e8ee"/>
     <text x="796" y="628" font-size="12" fill="#8796a5">🔒 Northwind Bank will never ask for your PIN by email.</text>
     <rect y="${h - 70}" width="${w}" height="70" fill="${NAVY}"/>
     <text x="48" y="${h - 30}" font-size="13" fill="#a9c4dd">© 2026 Northwind Bank, N.A.  ·  Privacy  ·  Security Center  ·  Accessibility  ·  Terms of Use</text>`,
  );
}

export function shotMobile() {
  const w = 390;
  const h = 844;
  return toDataUrl(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#eef2f6"/>
     ${header(w, true)}
     ${alertBanner(16, 82, w - 32, ["Unusual sign-in activity", "Verify within 24 hours to avoid", "account suspension."])}
     <rect x="16" y="210" width="${w - 32}" height="470" rx="10" fill="#fff" stroke="#d3dbe4"/>
     <rect x="16" y="210" width="${w - 32}" height="6" rx="3" fill="${TEAL}"/>
     <text x="40" y="262" font-size="22" font-weight="700" fill="${NAVY}">Sign in</text>
     <text x="40" y="288" font-size="13" fill="#6b7c8f">Online Banking · secure session</text>
     ${field(40, 320, w - 80, "User ID")}
     ${field(40, 410, w - 80, "Password")}
     ${button(40, 500, w - 80, "Verify &amp; Sign in")}
     <text x="${w / 2}" y="596" font-size="14" fill="${TEAL}" font-weight="600" text-anchor="middle">Forgot User ID or Password?</text>
     <text x="${w / 2}" y="644" font-size="11" fill="#8796a5" text-anchor="middle">Northwind Bank will never ask for your PIN by email.</text>
     <text x="${w / 2}" y="${h - 30}" font-size="11" fill="#8796a5" text-anchor="middle">© 2026 Northwind Bank, N.A.</text>`,
  );
}

export function shotOtp() {
  const w = 1280;
  const h = 800;
  const boxes = Array.from({ length: 6 }, (_, i) => {
    const x = 500 + i * 50;
    return `<rect x="${x}" y="360" width="40" height="54" rx="6" fill="#fff" stroke="${i === 0 ? TEAL : "#b8c4d0"}" stroke-width="${i === 0 ? 2 : 1.2}"/>`;
  }).join("");
  return toDataUrl(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#eef2f6"/>
     ${header(w)}
     <rect x="390" y="130" width="500" height="520" rx="10" fill="#fff" stroke="#d3dbe4"/>
     <rect x="390" y="130" width="500" height="6" rx="3" fill="${TEAL}"/>
     <g transform="translate(640 200)">
       <rect x="-22" y="-6" width="44" height="34" rx="5" fill="${TEAL}"/>
       <path d="M-13 -6 v-10 a13 13 0 0 1 26 0 v10" fill="none" stroke="${TEAL}" stroke-width="5"/>
       <circle cy="10" r="5" fill="#fff"/>
     </g>
     <text x="640" y="272" font-size="26" font-weight="700" fill="${NAVY}" text-anchor="middle">Security verification</text>
     <text x="640" y="308" font-size="16" fill="#3c5268" text-anchor="middle">Enter the 6-digit code we sent to your phone</text>
     <text x="640" y="332" font-size="16" fill="#3c5268" text-anchor="middle">ending in ••42 to confirm it's you.</text>
     ${boxes}
     ${button(450, 450, 380, "Confirm")}
     <text x="640" y="540" font-size="14" fill="${TEAL}" font-weight="600" text-anchor="middle">Didn't get a code? Resend in 0:47</text>
     <text x="640" y="610" font-size="12" fill="#8796a5" text-anchor="middle">For your protection this session expires in 5 minutes.</text>`,
  );
}

export function shotCard() {
  const w = 1280;
  const h = 800;
  return toDataUrl(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#eef2f6"/>
     ${header(w)}
     <rect x="390" y="110" width="500" height="600" rx="10" fill="#fff" stroke="#d3dbe4"/>
     <rect x="390" y="110" width="500" height="6" rx="3" fill="${TEAL}"/>
     <text x="430" y="170" font-size="24" font-weight="700" fill="${NAVY}">Confirm your debit card</text>
     <text x="430" y="200" font-size="15" fill="#3c5268">To restore full access, confirm the card linked to this account.</text>
     <rect x="430" y="224" width="420" height="40" rx="6" fill="#fff6e0" stroke="#efd28a"/>
     <text x="446" y="249" font-size="14" fill="#7a5a00">Step 2 of 2 · Your account is temporarily limited</text>
     ${field(430, 296, 420, "Card number", "", true)}
     ${field(430, 386, 200, "Expiry (MM/YY)")}
     ${field(650, 386, 200, "CVV")}
     ${field(430, 476, 420, "ATM PIN")}
     ${button(430, 576, 420, "Restore access")}
     <text x="640" y="680" font-size="12" fill="#8796a5" text-anchor="middle">🔒 Your information is protected with 256-bit SSL.</text>`,
  );
}
