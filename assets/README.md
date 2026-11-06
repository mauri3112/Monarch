# Monarch icons

`monarch.svg` is the source for the green-and-cream crown used by the Monarch
plugin. The web and desktop apps use the same artwork.

Run `vp run icons:export` to regenerate the development, nightly, and production
PNG and ICO assets, browser favicon and touch icons, and public SVG copies.
Run `vp run icons:check` to verify that every generated file matches its source.
Both commands work without Xcode or Icon Composer.

The macOS PNG uses a 1024px canvas with an 824px icon body inset by 100px.
The desktop packager creates its ICNS renditions from this PNG. Other platforms
use the full-size artwork. Keep the existing output paths so source launchers,
installers, and web packaging all use the generated Monarch icons.

The upstream Icon Composer projects and Android-specific artwork remain for
the unreleased mobile client. They are not sources for Monarch web or desktop
builds. Do not edit generated PNG or ICO files directly.
