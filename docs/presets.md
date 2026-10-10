# Caption looks: presets and URL parameters

Everything about how the translation looks can be changed: the panel, the blocks, the text, the Arabic, the Quran and dua accents, the honorifics (ﷺ), the Athan and Iqama cards, motion and the toolbar.

A saved look is called a **preset** here: that is its name in links (`preset=<id>`), in `presets.yaml` and in the API.

There are three ways to change it:

1. **Pick a look.** Ten built-in looks cover the common setups (below).
2. **Fine-tune in the look editor.** Open **Look** in the app, at **`/app/look`** (`pnpm turjuman open look`). On a server that is reachable from the network, log in as an admin first. It shows a live preview at the real screen size: a 1920×1080 screen, a 1920×400 lower third, or a phone. Copy the resulting caption or overlay link, or save it as your own look.
3. **Add URL parameters by hand.** Any caption page (`/ar/nl?…`) or overlay (`/overlay?…`) link accepts `preset=` plus the short parameters below, for example `/ar/nl?preset=glass&size=56&fg=ffe08a`.

Links only carry what differs from the preset, so they stay short and readable.

## Preset gallery

| Preset | Look | Best for |
|---|---|---|
| `mosque-dark` (**default**) | The reference design. A dark screen of rounded, readable blocks, one per complete thought, with the newest highlighted at the bottom. Older blocks dim and fade out at the top. Gold accent and gold `(2:286)` reference on Quran verses, a green accent on duas, and gold honorifics. Noto Sans 52 px, line height 1.35, about 42 characters per line. | Mosque TVs and projectors; a browser in full screen |
| `mosque-light` | The same layout with dark semibold text on warm white. The newest block is pure white with a soft shadow. | Bright halls and projectors, where black backgrounds wash out |
| `midnight-gold` | A deep navy panel floating on a navy screen, with gold hairlines, a Georgia serif and gold references and honorifics. | A refined, festive screen (Eid, special evenings) |
| `high-contrast` | Pure black, bold 60 px text with extra letter spacing. The newest block is yellow on a dark yellow tint. Older blocks are not dimmed, there is no top fade, and there is no motion. | Low-vision readers; accessibility |
| `minimal-transparent` | No panel and no boxes: centred white text with a strong shadow, three blocks at most, directly over the video. | OBS overlays on a camera picture |
| `glass` | A frosted, translucent floating panel with soft white blocks, a subtle blur and system-UI type. | Browser screens over a picture. In OBS the blur cannot reach the video (see the notes) |
| `sidebar-pip` | Blocks fill the left 68 % at full height, flush to the edge. The right side stays transparent for a picture-in-picture camera. | OBS with a camera on the right: the Browser Source over the whole canvas, the camera (for example over NDI) on the right with an Image Mask |
| `large-print` | Very large 76 px semibold text with only the last two blocks on screen. | The back of a large hall; elderly readers |
| `lower-third` | The classic roll-up: a dark rounded band at the bottom, with Arabic above and the translation below, two lines each. Only finished sentences appear (no live text). | OBS lower thirds, a 1920×400 Browser Source |
| `cinema` | Roll-up subtitles like a film: large 56 px white text with a deep shadow and no band, translation only. | Livestreams that want a clean film look |

You can save your own looks in the look editor (**Save as a look…**). They are stored on the server in `CONFIG_DIR/presets.yaml`, and every screen can then use `preset=<id>`. **Make … the default** sets the look used by links without a `preset=`.

## Examples

**OBS lower third**: a Browser Source of 1920×400 at the bottom of the canvas:
```
http://127.0.0.1:8765/overlay?preset=lower-third
http://127.0.0.1:8765/overlay?preset=lower-third&lines=3&size=48&blockBg=000000b3
```

**Picture-in-picture sidebar**: a Browser Source of 1920×1080 over the whole canvas. Put the camera on the right side with OBS's *Image Mask/Blend* filter for rounded corners:
```
http://127.0.0.1:8765/overlay?preset=sidebar-pip
http://127.0.0.1:8765/overlay?preset=sidebar-pip&width=62&panelBg=0b0b0ce6&radius=16
```

**Large print on the mosque screen** (a browser in full screen):
```
http://127.0.0.1:8765/ar/nl?preset=large-print
http://127.0.0.1:8765/ar/nl?preset=large-print&visible=1&size=90&fgNew=ffe600
```

**Minimal text over video**, with the Arabic under every block:
```
http://127.0.0.1:8765/overlay?preset=minimal-transparent&show=both&shadow=outline
```

**Solid background**: no video showing through the panel or the blocks:
```
http://127.0.0.1:8765/ar/nl?panelOpacity=100
http://127.0.0.1:8765/overlay?preset=sidebar-pip&panelOpacity=80&blockOpacity=80
```

**Tweaking the default look**: gold text for the newest block, serif type, no top fade:
```
http://127.0.0.1:8765/ar/nl?fgNew=ffe08a&font=georgia&fade=0
```

## How a link is resolved

1. **The preset.** It comes from `preset=<id>`, otherwise the server default (`display.preset`, set in the look editor), otherwise `mosque-dark`. Built-in ids cannot be reused by custom presets.
2. **The display options** below (`layout`, `bg`, `show`, `size`, …). A few follow the layout unless the preset or the link sets them:
   - `layout=blocks` defaults to `show=target` and `partial=0`.
   - `layout=rollup` defaults to `show=both`, `partial=1` and `bg=band`.
3. **The look parameters** below, one per CSS variable.

Parameter names are case-insensitive; when a parameter appears twice, the first one wins.

**Invalid values are dropped silently.** Every value passes a strict allow-list before it reaches the page's CSS: colours, simple gradients, lengths, numbers, the font keys below and keywords. A link can never inject CSS or load anything. The same check applies to custom presets from `presets.yaml`.

## Display options

| Param | Values | Default | Meaning |
|---|---|---|---|
| `layout` | `blocks` · `rollup` | `blocks` | Complete blocks stacked from the bottom, or the classic live roll-up |
| `bg` | `panel` · `none` · `band` · `shadow` | `panel` | Blocks: `panel` or `none` (a fully transparent page). Roll-up: `band` or `shadow`/`none` |
| `show` | `target` · `both` · `source` | by layout | Translation only; plus the Arabic source; or the Arabic only |
| `size` | 8–300 | `52` | Base text size in px (see *Text size* below). Readers can still use A− / A+ |
| `pos` | `bottom` · `middle` · `top` | `bottom` | Vertical placement of the panel or roll-up |
| `visibleBlocks` (`visible`) | 0–100 | `0` | Blocks shown at once (0 = as many as fit) |
| `maxBlocks` | 1–500 | `60` | Blocks kept in the page in OBS (follow mode) |
| `lines` | 1–20 | `2` | Roll-up lines per language |
| `history` | `1` · `0` | `1` | Scroll back through the session in a browser |
| `partial` | `1` · `0` | by layout | Live Arabic partial text next to the listening dots |
| `quranAccent` | `1` · `0` | `1` | Accent bar on Quran blocks |
| `quranArabic` | `1` · `0` | `1` | The Arabic verse (Amiri Quran) above the translation |
| `toolbar` | `auto` · `on` · `off` | `auto` | The toolbar (label, language, A− / A+). `auto` shows it in browsers and hides it inside OBS |

## Look parameters

The defaults are those of `mosque-dark`. Colours may be written without `#` (`fg=ffcc00`). Bare numbers take the unit in the *Accepts* column.

| Param | CSS variable | Accepts | Default |
|---|---|---|---|
| **Page and panel** | | | |
| `pageBg` | `--cap-page-bg` | colour, `none` or gradient | `transparent` |
| `panelBg` | `--cap-panel-bg` | colour, `none` or gradient | `rgba(17, 17, 17, 0.92)` |
| `panelRadius` | `--cap-panel-radius` | length (px) | `0` |
| `panelPad` | `--cap-panel-padding` | length (px) | `28` |
| `width` | `--cap-panel-width` | length (bare = vw) | `100` |
| `height` | `--cap-panel-height` | length (bare = vh) | `100` |
| `justify` | `--cap-panel-justify` | `left` · `center` · `right` | `center` |
| `panelShadow` | `--cap-panel-shadow` | shadow or keyword | `none` |
| `blur` | `--cap-panel-blur` | length (px) | `0` |
| `fade` | `--cap-fade-mask` | percent: the height of the top fade (`0` = none) | `18` |
| `panelOpacity` | alpha of `--cap-panel-bg` | 0–100 (%); `100` hides the video completely | `92` |
| **Blocks** | | | |
| `blockBg` | `--cap-block-bg` | colour, `none` or gradient | `1c1c20` |
| `blockBgNew` | `--cap-block-bg-new` | colour, `none` or gradient | `2b2b30` |
| `border` | `--cap-block-border` | `none` or `<width> [solid\|dashed\|dotted\|double] <colour>` | `1px solid rgba(255, 255, 255, 0.05)` |
| `radius` | `--cap-block-radius` | length (px) | `12` |
| `pad` | `--cap-block-padding` | 1–2 lengths (px): `vertical horizontal` | `14 22` |
| `gap` | `--cap-block-gap` | length (px) | `10` |
| `blockShadow` | `--cap-block-shadow` | shadow or keyword | `none` |
| `oldOpacity` | `--cap-old-opacity` | 0–1: text opacity of older blocks | `0.85` |
| `newScale` | `--cap-new-scale` | 0.9–1.2: lift of the newest block | `1.02` |
| `blockOpacity` | alpha of `--cap-block-bg` and `--cap-block-bg-new` | 0–100 (%) | `100` |
| **Text** | | | |
| `font` | `--cap-font-family` | font key | `noto-sans` |
| `size` | `--cap-font-size` | set by the `size` option | `min(52px, 5vw)` |
| `weight` | `--cap-font-weight` | 100–900, `normal`, `bold` | `400` |
| `lh` | `--cap-line-height` | 0.8–3 | `1.35` |
| `ls` | `--cap-letter-spacing` | length (px), may be negative | `0` |
| `fg` | `--cap-text-color` | colour | `f2f2f4` |
| `fgNew` | `--cap-text-color-new` | colour: the newest block's text | `ffffff` |
| `shadow` | `--cap-text-shadow` | text shadow or keyword | `none` |
| `align` | `--cap-text-align` | `start` · `left` · `center` · `right` · `justify` | `start` (Arabic lines align right) |
| `maxChars` | `--cap-max-chars` | number of characters (ch) or `none` | `42` |
| **Arabic and source text** | | | |
| `srcFont` | `--cap-src-font-family` | font key | `naskh` |
| `srcScale` | `--cap-src-scale` | 0.3–4, relative to the text size | `0.72` |
| `srcColor` | `--cap-src-color` | colour | `dcdce2` |
| `srcOpacity` | `--cap-src-opacity` | 0–1 | `0.6` |
| `arFont` | `--cap-arabic-font-family` | font key (event titles, partials) | `naskh` |
| `quranFont` | `--cap-quran-font-family` | font key (Quran Arabic) | `amiri-quran` |
| **Quran and dua** | | | |
| `accentWidth` | `--cap-accent-width` | length (px); `0` hides the bars | `4` |
| `quranColor` | `--cap-quran-accent` | colour | `d4a64a` |
| `duaColor` | `--cap-dua-accent` | colour | `4caf7d` |
| `refColor` | `--cap-ref-color` | colour of `(2:286)` | `d4a64a` |
| `refWeight` | `--cap-ref-weight` | 100–900 | `600` |
| **Honorifics (ﷺ ﷻ ﷾ ﵇ ﵁ …)** | | | |
| `honFont` | `--cap-hon-font` | font key | `naskh` |
| `honScale` | `--cap-hon-scale` | size in em (bare = em), 0.6–2.5 | `1.25` |
| `honColor` | `--cap-hon-color` | colour, or `currentcolor` to follow the text | `d4a64a` |
| **Athan and Iqama cards** | | | |
| `eventBg` | `--cap-event-bg` | colour, `none` or gradient | `1d2621` |
| `eventColor` | `--cap-event-color` | colour | `ffffff` |
| `eventAccent` | `--cap-event-accent` | colour (title and sound wave) | `d4a64a` |
| **Toolbar, listening dots and motion** | | | |
| `toolbarBg` | `--cap-toolbar-bg` | colour, `none` or gradient | `rgba(24, 24, 28, 0.92)` |
| `toolbarColor` | `--cap-toolbar-color` | colour | `e9e9ee` |
| `dotsColor` | `--cap-listening-color` | colour | `a6a6b0` |
| `anim` | `--cap-anim-duration` | ms (bare) or `0.2s`; `0` turns animation off | `200` |

### Value syntax

**Colours**
- Accepted forms: `ffcc00`, `#fc0`, `ffcc0080` (8 digits: the last two are the alpha), `rgb(255, 204, 0)`, `rgba(0, 0, 0, 0.6)`, `rgb(0 0 0 / 60%)`, `hsl(42, 80%, 55%)` and `transparent`.
- Named colours: `white`, `black`, `gold`, `navy`, `teal`, `gray`, …
- In a URL, write `#` as `%23`, or simply leave it out.

**Backgrounds** (`pageBg`, `panelBg`, `blockBg`, `blockBgNew`, `eventBg`, `toolbarBg`) also accept:
- `none`;
- `linear-gradient(to top, rgba(0,0,0,.8), transparent 70%)`;
- `radial-gradient(circle at bottom, …)`.

Gradients may have up to 8 colour stops.

**Lengths**: `px`, `em`, `rem`, `%`, `vw`, `vh`, `ch`. A bare number takes the parameter's unit: `radius=16` is `16px`, `width=70` is `70vw`.

**Fonts** are keys from an allow-list. Every Latin stack keeps Noto Naskh Arabic as a fallback, so ﷺ and Arabic always render with the bundled font.

| Key | Font | Script |
|---|---|---|
| `noto-sans` | Noto Sans (bundled) | Latin |
| `system` | The system UI font (San Francisco, Segoe UI, …) | Latin |
| `segoe` | Segoe UI | Latin |
| `sans-serif` | Helvetica Neue / Arial | Latin |
| `georgia` | Georgia | Latin |
| `serif` | Times New Roman | Latin |
| `naskh` | Noto Naskh Arabic (bundled) | Arabic + Latin |
| `amiri-quran` | Amiri Quran (bundled) | Arabic (Quran) |

**Shadow keywords**
- `shadow` (text): `none` · `soft` · `strong` · `outline` · `glow`.
- `panelShadow` and `blockShadow`: `none` · `soft` · `medium` · `strong` · `glow`.
- A raw shadow also works: `blockShadow=0 6px 20px rgba(0,0,0,.3)` (up to 6 layers; `inset` is allowed for boxes only).

## Notes on layout

**Text size**
- The text is `min(<size>px, 5vw)`. On phones and tablets it shrinks to stay readable (about 28 characters per line on a 390 px phone).
- From about 1040 px wide (TVs, OBS sources) it is exactly `size` px.
- A− / A+ scale on top of it.

**Line length**
- `maxChars` limits each block to about that many characters per line; the column is centred in the panel.
- For panels narrower than the column, the blocks fill the panel.
- 35–45 characters per line reads best. Use `maxChars=none` to fill any width.

**Panel size**
- `width` and `height` are the panel's size.
- With `pos=bottom` the panel sits on the bottom edge. Use `pos=middle` with `height` below 100 for a floating panel (as in `midnight-gold`).

**OBS**
- Keep `pageBg=transparent`; a colour fills the whole canvas.
- A Browser Source cannot see the video behind it, so `blur` only frosts content inside the page. The glass look still works in OBS, without the blur.

**Opacity**
- `panelOpacity` and `blockOpacity` change only the alpha of the panel and block backgrounds and keep their colour. They apply after `panelBg` / `blockBg`, so `panelBg=203040&panelOpacity=80` is a navy panel at 80 %.
- Transparent backgrounds (for example in `minimal-transparent`) stay transparent; give them a colour first.
- The look editor writes alpha-only changes this way; any other colour change becomes a colour parameter.

**Reduced motion**: the system's reduced-motion setting always switches the slide-in and dot animations off, whatever `anim` says.

## Custom presets (API)

| Request | Purpose |
|---|---|
| `GET /api/presets` | `{ builtin, custom, default }`. Open, because caption pages need it |
| `POST /api/presets` | Body `{ "preset": { id, name, description, vars, options } }`. Creates or updates a preset (admin). `id`: 1–48 characters, `a-z 0-9 -` |
| `DELETE /api/presets/:id` | Deletes a custom preset (admin) |
| `POST /api/config/save-default` | Body `{ "preset": "<id>" }`. Sets the server's default look (admin) |

"Admin": on a server that is reachable from the network (`server.exposure: lan` or `public`), these need an admin login or the admin token (`server.token`).

`presets.yaml` holds the same objects. `vars` uses the CSS variable names; `options` uses the display options:

```yaml
presets:
  - id: friday-glass
    name: Friday glass
    description: Glass with warm text for Jumu'ah.
    vars:
      --cap-text-color: "#ffe08a"
      --cap-block-radius: 18px
    options:
      size: 56
      quranArabic: true
```

The look editor saves **every** variable and option of the current look, so a saved preset does not change when a built-in preset is updated.

## For developers

The contract is in `src/shared/theme-vars.ts`; the module is `src/shared/theme.ts`.

| Export | What it does |
|---|---|
| `BUILTIN_PRESETS` | The ten built-in presets |
| `resolveTheme(params, custom?, defaultId?)` | Resolves `{ presetId, vars, options }` from a link |
| `applyTheme(el, vars)` | Sets the variables through the CSSOM only (allowed by the CSP) |
| `themeQuery(presetId, overrides, options, ctx?)` | Builds the minimal query string for a look |
| `sanitizeVars` / `sanitizeOptions` / `sanitizePreset` / `parseVarValue` | The allow-list validation |

The renderer is `web/shared/blocks.css` (blocks) and the roll-up renderer. Their CSS reads only these variables, each with a fallback.

The previews in the look editor and the builder come from `web/shared/preset-preview.ts`:
- `renderPresetPreview(preset, { width, height })` draws a gallery card.
- `buildStage(...)` draws the large stage.

They mirror `blocks.css` at the true screen size and scale it down.
