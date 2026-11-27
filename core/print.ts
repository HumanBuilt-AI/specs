// Print texture for posters and posts (Nov 27 poster spike). Composed CSS may not use url(), so
// code supplies the textures as CSS variables the model can only reference: paper grain, ink
// speckle and a worn-ink mask for big type. The textures are SVG noise, made here, not images
// from anywhere else. Pure: shared by spike/plate.ts and (later) the app.

const svg = (body: string, size = 300) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>${body}</svg>`)}")`;

// Fine grain, dark specks at low alpha: multiply it over paper.
const GRAIN = svg(
  `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.12  0 0 0 0 0.08  0 0 0 0 0.1  0.8 0 0 0 -0.4'/></filter><rect width='100%' height='100%' filter='url(#g)'/>`,
);
// Sparse ink specks and flecks.
const SPECKLE = svg(
  `<filter id='s'><feTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='2' seed='7' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.2  0 0 0 0 0.12  0 0 0 0 0.16  16 0 0 0 -11.2'/></filter><rect width='100%' height='100%' filter='url(#s)'/>`,
  400,
);
// Soft mottling, like paper that has been handled: light and dark blotches.
const MOTTLE = svg(
  `<filter id='m'><feTurbulence type='fractalNoise' baseFrequency='0.012' numOctaves='3' seed='3'/><feColorMatrix values='0 0 0 0 0.25  0 0 0 0 0.18  0 0 0 0 0.1  0.7 0 0 0 -0.3'/></filter><rect width='100%' height='100%' filter='url(#m)'/>`,
  1080,
);
// Worn ink: opaque except small irregular holes. Use as mask-image on big type or a painted band.
const WEAR = svg(
  `<filter id='w'><feTurbulence type='fractalNoise' baseFrequency='0.32' numOctaves='3' seed='11' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -14 0 0 0 9.4'/></filter><rect width='100%' height='100%' filter='url(#w)'/>`,
  260,
);

/** Appended to the kit's tokens.css: the only way composed CSS can reach a texture. */
export const PRINT_TEXTURE_CSS = `:root{--paper-grain:${GRAIN};--ink-speckle:${SPECKLE};--paper-mottle:${MOTTLE};--ink-wear:${WEAR};}`;

/** Painted art plate under a composition: full canvas, behind every element the model wrote. */
export const PLATE_CSS = `.post{isolation:isolate}.post>img.plate{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none}`;

/** Wireframe of a composition for the image model: every slot a flat gray block, nothing readable. */
export const WIREFRAME_CSS = `.post{background:#f4f1ea!important}.post *{color:transparent!important;text-shadow:none!important;border-color:transparent!important;box-shadow:none!important;background-image:none!important}.post [data-slot]{background:#9a9a9a!important;mask-image:none!important;-webkit-mask-image:none!important;filter:none!important;opacity:1!important}.post img[data-slot="photo"]{opacity:0!important}.post figure:has(img[data-slot="photo"]),.post [data-slot="photo"]{background:#555!important}.post .wordmark img{opacity:0!important}.post [data-echo]{visibility:hidden!important}.post div:not([data-slot]):not(:has([data-slot])){background:transparent!important}`;

/** Puts the plate image in as the first child of the post. */
export function withPlate(pageHtml: string, plateSrc: string): string {
  const esc = plateSrc.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return pageHtml.replace(/(<main class="post[^"]*">)/, `$1<img class="plate" src="${esc}" alt="" aria-hidden="true">`).replace("</head>", `<style>${PLATE_CSS}</style></head>`);
}
