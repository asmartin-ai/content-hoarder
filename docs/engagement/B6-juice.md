# B6 · Juice & Sensory Reward

*Make the moment a card commits feel physically good — abundant, immediate feedback for one swipe — so triage becomes its own reward, without tipping into overstimulation.*

## The idea

"Juice" is lavish, instant, tactile feedback in response to minimal input: you tap something and it bounces, wiggles, makes a little noise, and shakes the world a touch. The action stays the same; the *feeling* of doing it gets amplified. For content-hoarder, the target moment is the **swipe-commit** — the instant a card crosses the threshold and is Kept / Archived / Done. Right now that's a state change. Juice turns it into a small, satisfying event that the brain wants to repeat. The craft is to add just enough sensation to feel rewarding while staying calm and optional.

## The science / craft

The term "juice" comes from Kyle Gabler and the Experimental Gameplay Project's *How to Prototype a Game in Under 7 Days* (2005/GDC 2006), describing "constant and bountiful user feedback" — elements that "bounce and wiggle and squirt and make a little noise" [1]. Martin Jonasson and Petri Purho popularized it in **"Juice it or lose it"** (GDC Europe 2012), live-cranking a dull Breakout clone into a delightful one purely by stacking feedback [2]. Jan Willem Nijman's **"The Art of Screenshake"** (Vlambeer, 2013) shows the same on a shooter — bigger bullets, recoil, camera shake — micro-tweaks that transform feel [3].

Steve Swink's book **Game Feel** (2009) gives the rigor: game feel is "real-time control of virtual objects in a simulated space, with interactions emphasized by polish" — control, simulation, and polish (the juice layer) together [4].

Dan Saffer's **Microinteractions** (2013) provides the structure to build one cleanly: **trigger → rules → feedback → loops/modes** [5]. A swipe is the trigger; the commit threshold is a rule; haptic + sound + motion are the feedback.

Why feedback *reinforces*: B.J. Fogg's Tiny Habits says emotion wires habit, and the reinforcing emotion ("Shine"/celebration) must fire **while or immediately after** the behavior — operant conditioning, where closely-following reinforcement strengthens a behavior far more than delayed reward [6]. The Zeigarnik effect (Bluma Zeigarnik, 1927) explains the backlog's pull: started-but-unfinished tasks hold psychological tension until closed; a crisp completion cue *relieves* that tension, which is the felt "click" of clearing an item [7].

## How real apps do it

- **Tinder swipe** — drag the card and a Like/Nope overlay fades in live; release past the distance threshold and it flings off, but release short and a **spring snap-back** rubber-bands it home. The spring physics make "didn't commit" legible and physical [8]. This is the closest analog to content-hoarder's triage card.
- **Duolingo** — short, state-driven sounds and character animations fire on correct/incorrect answers; animation is part of the feedback loop, not decoration [9]. It works — and is also cited as where engagement design slides toward dark patterns / "digital guilt," a caution that juice can serve the app over the user [10].
- **iOS Taptic Engine** — Apple's crisp, distinct haptics (success vs. error taps) set the bar for "tactile but not buzzy." Note: that is a *native* channel; on the web, iOS Safari does **not** expose it (see below).
- **Vlambeer / "juicy" games** (Nuclear Throne) — screenshake, recoil, and particles make a single shot feel impactful [3] — the proof that tiny feedback dwarfs the raw input.

What backfires: a 2024 CHI study found juicy vs. non-juicy versions of a match-3 game did **not** differ in usability, performance, or "feeling clever" — juice mainly lifted aesthetic appeal, with mixed effects elsewhere [11]. And "too much juice" makes it hard to tell what actually matters — feedback becomes **noise** and can mask weak design [12].

## ⚠️ ADHD, accessibility & ethical caveats

- **Sensory overload is the headline risk.** ADHD sensory sensitivity means confetti bursts, loud snaps, or strong buzzes can cross from rewarding to aversive fast. Default to *subtle*; make intensity opt-in, never opt-out.
- **`prefers-reduced-motion` is non-negotiable.** MDN explicitly names ADHD (alongside vestibular disorders, migraine, epilepsy) as a reason users reduce motion; users expect interaction-triggered animation to be **off** unless essential [13][14]. Gate all motion polish behind it.
- **Sound must be off by default, short, and mutable.** Unexpected audio on a phone is the fastest way to make an app feel intrusive.
- **Reward the decision, not the gesture.** The danger is juicing the *swipe* so hard the dopamine attaches to flinging cards, encouraging mindless clearing over actual triage. Keep feedback proportional to the *decision*; don't escalate it into a slot-machine.
- **Honesty:** the evidence says juice mostly buys *appeal*, not better outcomes [11] — so treat it as making a chore pleasant, not as a productivity lever, and resist Duolingo-style guilt mechanics [10].

## Takeaways for content-hoarder

1. **[P1 · effort S · ship now]** Add a single short `navigator.vibrate()` on swipe-commit (e.g. ~15–25 ms) — distinct tiny patterns per action (Keep/Archive/Done). Maps to **triage swipe commit**. Android-Chrome PWA supports it [15]; feature-detect `'vibrate' in navigator`. Risk: over-long/buzzy patterns feel cheap — keep it crisp.
2. **[P1 · effort S · ship now]** Build the **commit-threshold logic** explicitly (distance/velocity past which the swipe "takes"), with a clean snap-back below it. Maps to **triage swipe commit**. Risk: threshold too low → accidental archives; pair with existing undo.
3. **[P1 · effort S · ship now]** Add a **global haptics + sound toggle** (default: haptics light-on, sound off) persisted in settings. Cross-cuts all feedback. Risk: shipping any feedback *without* the mute is the ethical line — do this first.
4. **[P1 · effort S · ship now]** Plumb **`prefers-reduced-motion`** as a CSS var / JS flag now, even before the design pass, so future animation auto-respects it [13]. Maps to whole UI. Risk: forgetting to actually branch on it later.
5. **[P2 · effort S · ship now]** Optional, *very* quiet UI **sound** (one soft tick per commit, mutable) — synthesize via WebAudio, no asset/library. Maps to **triage swipe commit**. Risk: annoyance on repeat; keep <80 ms and off by default.
6. **[P2 · effort M · ship now]** A subtly **stronger haptic on milestone moments** (daily goal hit, streak) — a two-pulse pattern distinct from per-card taps. Maps to **daily goal / Stats**. Risk: don't let milestone celebration nag; fire once, never repeat.
7. **[P2 · effort S · ship now]** Reward the **decision, not the gesture**: tie the satisfying cue to the *commit* event, and consider a tiny intentional delay/weight so rapid-fire swiping feels less slot-machine. Maps to triage loop. Risk: too much friction kills flow — tune lightly.
8. **[P3 · effort M · needs design pass]** **Card motion polish** — easing/spring curves for the fling and snap-back (Tinder-style) [8]. Maps to **triage swipe commit**. Risk: spring stiffness wrong = sluggish or jittery; needs the visual model.
9. **[P3 · effort M · needs design pass]** **Milestone celebration art** (a restrained particle/confetti or glow on goal completion). Maps to **milestone moment / Stats**. Risk: the canonical overstimulation trap — design it *calm*, behind reduced-motion, and don't reach for a heavy animation lib (a tiny canvas burst is enough).
10. **[P3 · effort S · needs design pass]** **Drag-state visual feedback** (color/overlay shift as a card nears its threshold), the legibility half of Tinder's overlay [8]. Maps to **triage swipe commit**. Risk: too flashy mid-drag distracts; keep to a quiet tint.

## Sources

1. Kyle Gabler et al., *How to Prototype a Game in Under 7 Days* — https://www.gamedeveloper.com/game-platforms/how-to-prototype-a-game-in-under-7-days
2. "Juice it or lose it" (Jonasson & Purho, GDC Europe 2012), video — https://www.youtube.com/watch?v=Fy0aCDmgnxg ; GDC Vault — https://www.gdcvault.com/play/1016487/Juice-It-or-Lose
3. "The Art of Screenshake" (Jan Willem Nijman, Vlambeer) — https://www.youtube.com/watch?v=AJdEqssNZ-U ; Vlambeer — https://en.wikipedia.org/wiki/Vlambeer
4. Steve Swink, *Game Feel* — https://www.goodreads.com/book/show/3385050-game-feel ; "Game feel" overview — https://en.wikipedia.org/wiki/Game_feel
5. Dan Saffer, *Microinteractions* — https://www.oreilly.com/library/view/microinteractions/9781449342760/ ; four components — https://blog.prototypr.io/the-4-components-of-a-microinteraction-836732173c7c
6. B.J. Fogg, Tiny Habits — celebration/Shine — https://tinyhabits.com/rewire/ ; https://ideas.ted.com/how-you-can-use-the-power-of-celebration-to-make-new-habits-stick/
7. Zeigarnik effect — https://en.wikipedia.org/wiki/Zeigarnik_effect ; https://www.simplypsychology.org/zeigarnik-effect.html
8. Tinder-style swipe spring physics & snap-back — https://medium.com/swlh/tinder-card-swipe-feature-using-react-spring-and-react-use-gesture-7236d7abf2db ; https://medium.com/@phillfarrugia/building-a-tinder-esque-card-interface-5afa63c6d3db
9. Duolingo microinteractions (sound/animation feedback) — https://medium.com/@Bundu/little-touches-big-impact-the-micro-interactions-on-duolingo-d8377876f682
10. Duolingo dark patterns / digital guilt critique — https://opinionsandconditions.substack.com/p/duolingo-owl-dark-patterns-digital-guilt
11. "How does Juicy Game Feedback Motivate?" (CHI 2024) — https://dl.acm.org/doi/10.1145/3613904.3642656
12. "The 'Juice' Problem: How Exaggerated Feedback is Harming Game Design" — https://www.wayline.io/blog/the-juice-problem-how-exaggerated-feedback-is-harming-game-design
13. `prefers-reduced-motion` (MDN, names ADHD/vestibular) — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
14. Using media queries for accessibility (MDN) — https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Using_media_queries_for_accessibility
15. Vibration API (MDN) — https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API ; browser support (caniuse: Android Chrome ✅ / iOS Safari ❌) — https://caniuse.com/mdn-api_navigator_vibrate

---
*Part of the content-hoarder [engagement research set](README.md). Researched 2026-06-14 (Claude + web sources; load-bearing claims verified, ship-now vs design-gated tagged per takeaway).*
