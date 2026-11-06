# wayback-to-video

Pulls one Wayback Machine snapshot per year for any website and encodes an H.264 `.mp4` time-lapse in your browser with `ffmpeg.wasm`.

Live at [h3manth.com/fun/wayback-to-video](https://h3manth.com/fun/wayback-to-video/).

```bash
npm install
npm start
```

Opens at `http://localhost:4321` (or pass a domain directly via `?url=info.cern.ch`).

## How it works

```bash
# 1. One 200 OK HTML capture per year from the Wayback CDX index
curl "http://localhost:4321/api/timeline?url=info.cern.ch"

# 2. Clean 1280x800 frame from Wayback's raw if_ replay URL
curl -o 1997.jpg "http://localhost:4321/api/snapshot?timestamp=19970404065412&url=http://info.cern.ch:80/"
```

`/api/timeline` queries `web.archive.org/cdx/search/cdx` with `collapse=timestamp:4` so you get one snapshot per archived year instead of thousands of daily crawls. `/api/snapshot` loads the raw `if_` archive page without the Wayback toolbar and caches a `1280x800` image on disk.

In the browser, [`public/app.js`](./public/app.js) draws each year onto a `1280x720` `<canvas>` with cross-dissolves and runs `@ffmpeg/ffmpeg` (`libx264`, `yuv420p`) in WebAssembly to output the downloadable `.mp4`. Click any year on the bottom filmstrip to scrub, or toggle off parked years and re-encode.

## License

MIT © [Hemanth.HM](https://h3manth.com)
