# LCU Reader

A brand-new Electron app that decodes and browses **Rock 'n' Roller Coaster Soundtracker `.lcu` show-control files**.

Fresh, standalone implementation (not derived from the old `lcu-soundtracker-reader`). The decoder lives in `src/lcuDecoder.js` and is UI-independent, so the same code can be reused or tested from Node.

## Run

```bash
npm install
npm start
```

Or double-click `run.bat`.

## Test the decoder against the real files

```bash
npm test
```

(Requires the 5 `.lcu` files in `C:\Users\piete\Pictures\...\LCU Soundtracker`.)

## What it decodes

| Section | Contents |
|---------|----------|
| `V` | Firmware format version |
| `K` | Metadata (compile date, train id, soundtrack title) |
| `O` | Network config (IP / gateway / subnet) |
| `D` | Audio delay presets |
| `G` | Audio group names |
| `W` | Onboard sound library (36 clips: name, sample rate, channels, samples, duration) |
| `P` | Phrase presets (volume L/R, pitch, fades, speaker bus) |
| `R` | Group channel → phrase routing matrix |
| `S` | Show sequences + timed cue events (144 start / 128 stop, relays, volume, DSP, calls) |
| `T` | Hardware triggers, sensors, relays |
| `Q` | Parametric EQ: one or more profiles, each made of 30-register filter banks |
| `C E M F A` | Kept raw for reference |

## Views

- **Overview** — stat cards + file summary (vehicle, network, groups, delays)
- **Sequences & Cues** — filterable sequence list, per-sequence mini timeline strip, full event table
- **Audio Library** — wave table
- **Phrase Presets** — phrase table
- **Routing Matrix** — channel/phrase mappings
- **Hardware I/O** — triggers + EQ registers
- **EQ Curves** — plots each equalizer bank (Section Q) as a curve: 30 registers per bank, values decoded as signed offsets from midscale `0x40` (0 dB). Handles multiple profiles per file (e.g. `emoton5h` has "Default EQ Settings" + "untitled"). Use **Compare another .lcu...** to overlay a second train's tuning.
- **Raw Sections** — every section as stored

Plus drag-and-drop `.lcu` open, file dialog, and JSON/CSV export.

## EQ register format

Section `Q` holds one or more profiles:

```
<profileIndex>
<profileName>
<bankCount>
<magic u16>
<reg>:<value> ...        (ordered, 30 pairs per bank)
-1:
```

- Values are 7-bit, offset-binary: `64` (0x40) = 0 dB, `< 64` = cut, `> 64` = boost.
- Every bank shares the same 30-address DSP map; banks are stored back to back.
- The exact register→frequency mapping is not documented, so the curve shows the relative tuning shape (register position vs signed offset), not calibrated Hz/dB.