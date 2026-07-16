# Soul Echo Audio Assets

Drop generated ambience tracks here and wire them in `demo/src/shared/souls.mjs`.

Recommended filenames:

- `sushi-rain-river.mp3`
- `yangming-night-desk.mp3`
- `buddha-still-water.mp3`
- `nietzsche-mountain-fire.mp3`
- `zhuangzi-evening-boat.mp3`

Then set the matching `ambient.audioSrc`, for example:

```js
ambient: {
  sound: "雨后江风 · 茶盏轻响",
  texture: "水面微光慢慢铺开，像一口气终于落回胸口。",
  cue: "先听一阵雨后的风，再开口。",
  audioSrc: "/audio/sushi-rain-river.mp3",
}
```

Keep loops subtle, preferably 60-120 seconds, low volume, no strong melody, and no sudden transient sounds.
