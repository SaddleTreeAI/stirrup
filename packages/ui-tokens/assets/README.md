# Stirrup icon source

`Stirrup.icon` is the shared editable Apple Icon Composer source. Its centered
copper stirrup mark is shared by web, desktop and mobile exports. The source was
generated with OpenAI ImageGen as an equestrian stirrup iron with an S-shaped
crossbar on transparency.

Run `pnpm --filter @rakazo/ui-tokens export:brand` to regenerate the platform
icons, splash, favicons and downloadable brand kit. Apple packaging compiles the
Icon Composer source; Android applies its own launcher mask. App icons use the
shared dark background token. Notification and themed Android icons use the
mark's alpha silhouette. The desktop legacy export includes Dock margins.

The existing animated character avatars remain available as a saved appearance
option. They are independent of the Stirrup application icon.

`character/orange-bot.png` retains the original character artwork as the visual
reference for existing animated avatars. It is not an application icon export.
