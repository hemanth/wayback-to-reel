---
name: wayback-to-reel
description: Query one Internet Archive Wayback Machine snapshot per archived year for any domain and generate an H.264 MP4 time-lapse reel in the browser with FFmpeg WebAssembly.
---

# Wayback Reel Skill

## HTTP Endpoints
- Timeline: `GET https://h3manth.com/fun/wayback-to-reel/api/timeline?url={domain}`
- Snapshot Image: `GET https://h3manth.com/fun/wayback-to-reel/api/snapshot?timestamp={timestamp}&url={originalUrl}`

## Browser / WebMCP Usage
Open `https://h3manth.com/fun/wayback-to-reel/?url={domain}` or invoke `navigator.modelContext` tool `create_wayback_video({ url, secondsPerYear })` to render and download an H.264 `.mp4` reel locally in WebAssembly.
