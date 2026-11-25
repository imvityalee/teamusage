# teamusage

## Design skills

The design skills in `.claude/skills/` are part of how UI work is done in this repository. Before writing,
changing or reviewing anything a person sees or touches (the dashboard and every page under
`packages/server/web/`, the landing page, the team page, design mock-ups), load the matching skill with the
Skill tool and follow it. Load it first, before reading code or proposing a design. When several match, load
each one. When none obviously matches, load `ask-emil`, which routes to the right one.

| The work | Skill |
|----------|-------|
| Building or polishing a component: press and hover states, popovers, tooltips, transitions, small details | `emil-design-eng` |
| Layout, typography, materials, depth, spring and gesture-driven motion | `apple-design` |
| Trying several different versions of a piece of UI before choosing one | `prototype` |
| Checking UI against worst-case data: long names, empty lists, huge numbers, non-Latin text | `break-ui` |
| Making the pages feel right on a phone | `mobile-native` |
| Adding an animation | `animate` |
| Several elements that move together: staggered lists, entrances, view swaps | `choreograph` |
| Drag, swipe, sheets, anything dismissed with a gesture | `gestures` |
| An animation that stutters, or choosing which property to animate | `animation-performance` |
| Reviewing motion code | `review-animations` |
| Auditing existing motion and planning improvements | `improve-animations` |
| Finding places that should animate and do not | `find-animation-opportunities` |
| Removing motion the interface does not need | `remove-animations` |
| Naming a motion effect from a loose description | `animation-vocabulary` |
| Choosing a frontend library | `pick-ui-library` |
| Turning design corrections from a session into lasting rules | `learn-taste` |

`ask-sonner` and `animate-expo` cover Sonner (React) and React Native; this repository uses neither.
`write-swift` is for Swift code.

After UI work that is more than a text change, run `break-ui` on what was built and `review-animations` on any
motion that was added, before calling the work done.

The skills give the principles; the repository's own rules decide how they are built here. The dashboard is
vanilla TypeScript built with Vite under a strict Content-Security-Policy, with every string in English and
Russian (`packages/server/web/src/i18n.ts`). Where a skill reaches for a library or a framework, apply the idea
with what the repository already has, and ask before adding a dependency.
