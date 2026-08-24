# Codelit MLX helper

This native Apple Silicon helper is the feasibility path for Codelit's built-in
local models. It owns model loading and emits one validated JSON object on
stdout. Download progress and failures go to stderr so the Tauri process can
keep the provider protocol deterministic.

The default probe model is `mlx-community/Qwen3-0.6B-4bit`. Normal desktop
builds do not build this helper or download weights. The release pipeline will
bundle a signed build only after the model license, hash manifest, quality,
memory, and thermal gates pass.

```sh
npm run desktop:mlx:build
npm run desktop:mlx:probe
```

The release build intentionally uses `xcodebuild`. Command-line SwiftPM can
compile MLX sources but cannot build the Metal shader library required at
runtime. Xcode DerivedData is kept in the system temporary directory so native
dependencies never enter the web build's source tree.
