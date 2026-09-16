# homingvector-site

The public website for Homingvector: TurtleShield (the AI) and Turtle Eyes (its ground control station).

- `index.html` is the whole page, with no build step. Fonts are self-hosted in `fonts/`.
- `media/` holds the CGI film (`hero-film.mp4`, `hero-film.webm`) and its poster. They are rendered in Blender by the film project that sits beside this repo on the SanDisk (`../film/blender/`); see `../HOW_TO_EDIT.txt`.
- The Turtle Eyes console on the page is drawn in the browser. It is an illustration, not flight code.
- `tools/linkedin.html` makes the LinkedIn banner, post image and logo.

Figures on the page come from the TurtleShield deck (`content.py` / `CLAIMS.md`, as of 2026-09-15). When those numbers change, update the Status section by hand.

Hosted on GitHub Pages from the `main` branch root.
