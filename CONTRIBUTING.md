# Contributing to Lumen

Thanks for helping! Bug fixes, new apps, new environments and UI ideas are all welcome.

## Reporting a bug

Open an issue and include:
- what you did, what you expected, and what happened instead;
- your phone model and Android version (or your browser, for the web version);
- web or Android app, and the Lumen version (shown on the download button);
- a screenshot or short clip if you can.

Security problems: please email report@aneyex.com instead of opening a public issue.

## Sending a fix or feature

1. Fork the repository and make a branch.
2. Keep changes focused: one fix or feature per pull request.
3. Test it: run the web app locally (see the README) and, if you touched the Android
   side, build and install the debug APK.
4. Open a pull request that says what changed and how you tested it.

Code style: plain modern JavaScript (ES modules, no build step) and plain Java for
Android. Match the style of the file you're editing.

By sending a pull request you agree that your change to Lumen's own code is released
under the project's MIT license. Apps and add-ons you keep in your own files or
repositories stay yours under whatever terms you choose.

## Never commit

- signing keys (`*.jks`, `keystore.properties`), `local.properties`, built APKs;
- passwords, tokens, server addresses or anything personal.
