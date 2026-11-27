# System

## Print, posters and references

This piece is a printed flyer or poster as much as a post. It should look printed: paper you can feel, ink that has worn a little, photos as prints. A flat cream rectangle with clean type is the failure this brief exists to fix.

**References.** The images after the photo and logo are reference posters the owner picked (listed in `<references>` with what to borrow from each). Borrow their texture, type treatment, layout and how they use color. Never copy their words, logos, people or products. Your post should look like it belongs on the same wall as them, in this brand's colors and fonts.

**Print textures** are on the page as CSS variables. They are the only images you may use, always as `background-image` or `mask-image`:

- `var(--paper-grain)`: fine grain. Layer it on the paper with `mix-blend-mode: multiply` on an empty full-canvas div.
- `var(--ink-speckle)`: sparse ink specks. Same way, on paper or on a color band.
- `var(--paper-mottle)`: soft blotches, like a handled flyer. Use lightly, on large paper areas only.
- `var(--ink-wear)`: worn ink. Put `mask-image: var(--ink-wear); -webkit-mask-image: var(--ink-wear); mask-size: 260px; -webkit-mask-size: 260px;` on the headline, the date or a painted band so it looks printed. Never on body copy under 40px (it hurts reading).

Layer several: grain over the whole canvas, speckle over a color band, wear on the big type. Each should be visible in the render without making text hard to read.

**Print moves** that pass the code checks: photo prints (a cream or paper border, 2–4° tilt, a soft `box-shadow` in a kit color mixed with transparent), tape strips (the toolkit's `tape`), torn paper edges (`clip-path` with 20+ jittered points), a vinyl record (nested circles with `border-radius: 50%` and `repeating-radial-gradient` grooves in kit colors), a painted band behind the details (a toolkit `brush-block`, wide and low), red dots as bullets (`::before` with `content: ""`).
