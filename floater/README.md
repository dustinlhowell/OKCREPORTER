# Floater

A one-tap arcade game: rise between the defenders' hands and stay off the hardwood. The whole game is a single canvas page in `www/index.html`, wrapped as an iOS app with [Capacitor](https://capacitorjs.com).

## What's here

| Path | What it is |
| --- | --- |
| `www/` | The game (HTML + bundled fonts). Works offline. |
| `ios/` | Native Xcode project (Swift Package Manager, no CocoaPods). |
| `capacitor.config.json` | App id, name, splash and status bar settings. |
| `resources/icon-1024.png` | App Store icon (opaque, 1024 × 1024). |
| `resources/screenshots/` | 6.9" iPhone screenshots (1320 × 2868) for App Store Connect. |
| `tools/render-assets.mjs` | Re-renders the icon, launch image and screenshots from the game's own drawing code. |
| `STORE_LISTING.md` | Copy for the App Store listing. |
| `PRIVACY.md` | Privacy policy to host at a public URL. |

Native touches: light haptic on every jump, a stronger one on each bucket, an error buzz when you get blocked; the run pauses when the app goes to the background; portrait only; status bar hidden.

## Play it in a browser

Open `www/index.html` directly, or serve the folder: `npx serve www`.

## Ship to the App Store

You need a Mac with Xcode 16 or later and a paid Apple Developer account ($99/year).

1. **Install and sync**
   ```sh
   npm install
   npx cap sync ios
   npx cap open ios
   ```
2. **Set your identity in Xcode** (App target → Signing & Capabilities)
   - Team: your developer team.
   - Bundle Identifier: change `com.example.floater` to one you own, e.g. `com.yourname.floater`. Update `appId` in `capacitor.config.json` to match.
3. **Test on a device.** Plug in an iPhone, choose it as the run destination, press Run.
4. **Create the app record** in [App Store Connect](https://appstoreconnect.apple.com) → My Apps → + New App, using the same bundle id. Check that the name "Floater" is available; if not, try "Floater: Hoops Hop" or similar and change `CFBundleDisplayName` only if you want the home-screen name to change too.
5. **Archive and upload.** In Xcode: select "Any iOS Device (arm64)", then Product → Archive → Distribute App → App Store Connect → Upload.
6. **Fill in the listing** from `STORE_LISTING.md`, upload the screenshots in `resources/screenshots/`, host `PRIVACY.md` somewhere public (a GitHub Pages site or gist works) and paste its URL.
7. **App Privacy:** answer "Data Not Collected". The game stores only your best score on the device.
8. **Age rating:** answer "None" to everything; it rates 4+.
9. Pick the build, then **Submit for Review**.

## Changing the game

Edit `www/index.html`, then:

```sh
npx cap sync ios                 # copy the web files into the Xcode project
node tools/render-assets.mjs     # only if the look changed; needs `npx playwright install chromium` once
```

Bump **Version** (or **Build**) in Xcode before each new upload.
