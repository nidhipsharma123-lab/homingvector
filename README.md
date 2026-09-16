# homingvector-site

The public website for Homingvector: TurtleShield (the AI) and Turtle Eyes (its ground control station).

- `index.html` is the whole page, with no build step. Fonts are self-hosted in `fonts/`.
- `media/` holds the CGI film (`hero-film.mp4`, `hero-film.webm`) and its poster. They are rendered in Blender by the film project that sits beside this repo on the SanDisk (`../film/blender/`); see `../HOW_TO_EDIT.txt`.
- The Turtle Eyes console on the page is drawn in the browser. It is an illustration, not flight code.
- `tools/linkedin.html` makes the LinkedIn banner, post image and logo.

## Figures on the page

**Every figure is RE-DERIVED from the repo before publishing. Never hand-copied,
and never traced to the deck alone.**

`CLAIMS.md` and `derived.json` are *snapshots*. A figure can match its CLAIMS row
perfectly and still be stale, because the corpus moves. On 2026-09-16 the page
read 742 missions and 531 passed while the repo held 768 and 555 — internally
consistent, arithmetically sound, and wrong. A proofreader would have found
nothing. So the deck is provenance, not truth; the repo is truth.

Run the gate before every publish:

    tools/check_figures.py              # check the page against the repo
    tools/check_figures.py --self-test  # prove every failure rule can still fire

It reads each `data-figure="..."` value out of `index.html`, re-derives it, and
**exits non-zero on any mismatch**. It also refuses on anything it cannot check:
an unknown key, a derivation that raises, a missing source file, an empty result
where zero was not the asserted value, or an exemption with no reason recorded.
An unchecked figure is not a passing figure.

Two figures cannot be re-derived and are handled explicitly rather than skipped:

- `nav_error_without_gps` is exempt by name, because it comes from a written
  report section rather than a results column.
- The "2,000+" orbit commands figure carries **no marker at all** — it was
  counted by hand and the logs behind it are not all kept. The gate instead
  requires the sentence saying it cannot be recounted to stay on the page.
  Delete that caveat and the gate fails, because an un-recountable number
  without its caveat is an unsourced claim.

Hosted on GitHub Pages from the `main` branch root.
