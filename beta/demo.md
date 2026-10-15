# Tasks

Demo file. Each `## heading` is a list, each `### heading` is a section. One task per line: `- [ ] Title due:YYYY-MM-DD at:HH:MM every:week !1 #tag ^id`. A window task adds `by:YYYY-MM-DDTHH:MM lead:2h est:20m`; a sticky keeps its deadline in `by:`. Notes sit under a task, indented by two spaces.

## Inbox color:#3e8ef7/blue
- [ ] Welcome! Open this task to read how the demo works due:2026-10-10 !1 #help ^demo01
  This is a demo. Your changes stay in this browser only, and the demo resets each day.
  To use your own list, tap the ? button at the top: Help explains the private repository, the token and the reminders.
  - [x] Open a task
  - [ ] Check a checklist item
  - [ ] Complete a task with the round box
- [ ] Try the quick-add bar with a full sentence due:2026-10-10 #help ^demo02
  Example: Call the bank tomorrow 9am every week #money !1 @Life
  The parser reads dates, times, repeats, tags, priority and @List in English or French.
  On a computer, press n to add a task, 1 to 5 to change the Agenda range and m for Matrix.
- [/] Task in progress: open a task, then Details → Status → In progress #help ^demo03
- [ ] Open Matrix: it sorts open tasks by urgent and important #help ^demo06
- [ ] Overdue task: it shows in red at the top of Today due:2026-10-08 ^demo04
- [x] Done task: it moves to Done done:2026-10-09 ^demo05

## Life color:#db2777/pink
- [ ] Dentist appointment due:2026-10-10 at:17:30 #health ^demo10
  A task with a time sends a phone reminder at that time.
  A task with a date and no time shows only in the 08:00 digest.
- [ ] Pay rent due:2026-11-01 every:month #money #home !2 ^demo11
  Completing a repeating task moves its date to the next slot.
  Open View options (the sliders at the top right) and pick Group by · Tag: this task has two tags, so it shows in #money and, faded, in #home.
- [ ] Water the plants due:2026-10-11 every:3d #home ^demo12
- [ ] Bins out due:2026-10-12 every:mon,thu at:20:00 #home ^demo13
- [ ] Clean the fridge due:2026-11-02 every:1mon #home ^demo14
  "1mon" means the first Monday of the month; "-1fri" means the last Friday.
- [ ] Team drinks due:2026-10-30 every:-1fri at:18:00 #social ^demo15
- [ ] Renew passport due:2026-10-24 !1 #admin ^demo16
  Group by Priority or Date also works. On a computer, the Board grouped by tag moves a tag: drag this task from #admin to #money.
- [ ] Cancel the gym subscription due:2026-10-31 #money #admin !3 ^demo18
- [ ] Book the car service #admin ^demo19
- [ ] Mum's birthday due:2027-03-14 every:year #family #social ^demo17
- [ ] Sort the photos of the summer ^demo1a
  A task with no tag goes to the group « No tag », at the bottom.
- [ ] Return the library books due:2026-10-09 at:09:00 by:2026-10-11T18:00 lead:2h est:20m !2 ^win01
  A window task (story L15): start = date + reminder, deadline = by, margin = lead, estimate = est. It is in its window: act before the act-by time. The bar shows the window in blue, the margin hatched red, and now.
- [ ] Collect the dry cleaning due:2026-10-11 at:09:00 by:2026-10-11T18:00 lead:2h est:20m !2 ^win02
  It opens tomorrow at 09:00: the row is faded, and Matrix never shows it as urgent before its start.
- [ ] Send the tax form due:2026-10-08 by:2026-10-11T12:00 lead:2d est:1h ^win03
  Act by has passed, the deadline is still ahead: the margin. The row is red and sits at the top of Today.
- [ ] Water the neighbour's plants due:2026-10-09 at:15:00 by:2026-10-09T18:00 lead:2h est:20m ^win04
  The deadline has passed: missed. It leaves the urgent part of Matrix and stays until you close it.
- [ ] Drop the keys at the agency due:2026-10-11 at:17:50 by:2026-10-11T18:00 lead:2h est:20m ^win05
  Start + estimate is after act by: the amber chip says the window is too short. Move the start earlier.
- [ ] Pay the monthly bills due:2026-11-02 by:2026-11-04 est:2h every:1wd ^win06
  First office day of the month, deadline the 4th. Done: the start moves to the next first office day, the deadline to the 4th of that month.
- [ ] Restart the home server due:2026-10-11 at:20:00 ~start est:1h !2 ^win07
  A fixed start with no deadline (story L24): the flag ~start (Start « Not before » in the panel) makes the date and hour a start. It opens tomorrow at 20:00: faded until then, out of Matrix and Lanes. After the start, a plain task.

## Stickies ~stickies color:#64748b/slate
- [ ] Renew the ID card before the trip by:2026-10-14 ~firm ^demo60
  A sticky (pense-bête) is one thing not to forget, not a step to do. It shows in the Agenda on its date, and on the horizon line under the day strip.
  Firm: the date must not pass. J-x counts the days left; it turns red within 7 days.
- [ ] Return the rental bike by:2026-10-15 ^demo64
  Same week as the ID card: one pill on the horizon, with paper behind it and a badge for the count. Hover it on a computer to read the titles; tap it to open Stickies.
- [ ] Book the train for the holidays by:2026-10-30 ^demo61
  Best effort: do it before the date if you can.
- [ ] Book the hairdresser for the wedding by:2026-10-29 ~firm lead:10d ^demo67
  A lead (lead:10d): the slot must be booked 10 days before the deadline. The horizon line shows the act-by date, not the deadline: violet while it is far, red within 7 days, at Today in red once it has passed.
- [ ] Book the dentist check-up by:2026-12-15 lead:30d ^demo68
  Best effort with a lead of 30 days: an outlined violet pill on the act-by date.
- [ ] Use the cinema vouchers by:2026-12-30 ^demo65
- [ ] Renew the domain name by:2026-12-31 ~firm ^demo66
- [ ] Gift card expires by:2026-12-31 ~firm ^demo62
  Far dates sit at the right end of the horizon line: it covers 12 weeks.
- [ ] Ask about the frequent traveller card ^demo63
  No date: it waits on the Stickies page, off the horizon. Add a date when you review it.

## Habits ~habits color:#65a30d/lime
### Morning
- [ ] 📖 Read due:2026-10-10 every:day streak:5 #1min ^demo50
  The Agenda shows the habits of the next 4 hours as tiles: tap a tile to check it, tap beside the tiles to open Habits. A section name gives the time: Morning, Midday, Afternoon, Evening.
  A one-minute habit (#1min): the minimum is one minute, so the title has no number. It tells the brain it is nothing, so you start. Check it to grow its streak; the squares show the last 7 days.
  ✓ 2026-10-05 2026-10-06 2026-10-07 2026-10-08 2026-10-09
- [ ] 💪 Push-ups due:2026-10-09 every:day streak:3 #1min ^demo51
  Missed yesterday: no red, no overdue. The streak reads 0 and starts again at the next check-in.
  ✓ 2026-10-06 2026-10-07 2026-10-08
### Midday
- [ ] 🍪 Snack before the lunch run due:2026-10-12 at:11:30 every:weekday streak:off ^demo52
  Reminder only (streak:off): no count, no squares, just the 11:30 push on weekdays. Open a habit, then Details → Streak to switch.
- [ ] 🧘 Core session due:2026-10-12 every:mon,thu streak:3 ^demo54
  A habit can repeat on some days only. Until its next day, it waits under Later.
  ✓ 2026-10-01 2026-10-05 2026-10-08
### Evening
- [ ] 🤸 Stretch due:2026-10-11 every:day streak:8 #1min ^demo53
  Done today: it stays checked in the list until tomorrow, and leaves the Today strip.
  ✓ 2026-10-03 2026-10-04 2026-10-05 2026-10-06 2026-10-07 2026-10-08 2026-10-09 2026-10-10
- [ ] 🧹 Tidy up due:2026-10-10 every:day streak:2 #1min ^demo55
  Set a 1-minute timer and put things away until it rings.
  ✓ 2026-10-08 2026-10-09

## Groceries ~stock color:#e2900b/amber
- [ ] Oat milk ^demo20
- [ ] Bananas ^demo21
- [/] Coffee beans ^demo22
### Weekly
- [x] Bread done:2026-10-09 ^demo23
- [x] Eggs done:2026-10-07 ^demo24
### Monthly
- [x] Olive oil done:2026-09-20 ^demo25
### Rare
- [x] Soy sauce done:2026-08-30 ^demo26

## Work color:#0f9d9a/teal
- [ ] Weekly report due:2026-10-16 at:10:00 every:week ^demo30
- [ ] Prepare the Monday slides due:2026-10-12 !1 #meeting ^demo31
  - [ ] Collect the figures
  - [ ] Draft the outline
  - [ ] Ask Sam to review
### This week
- [ ] Reply to the supplier email due:2026-10-13 ^demo32
- [/] Fix the login bug #dev ^demo33
  Try the Board and Lanes views with the buttons at the top of this list.
  The section Someday is empty, so it hides: View options → the eye « Empty sections » shows it. « Done tasks » shows the tasks done in the last 7 days.
- [x] Send the invoice done:2026-10-09 ^demo36
### Later
- [ ] Read the security audit ^demo34
  The PDF is in the shared drive, folder Audits 2026. A task with notes and no chip: Settings › Beta features › L30 moves the notes mark to the top right.
- [ ] Plan the Q1 roadmap due:2026-11-15 !2 ^demo35
### Someday

## Training color:#a855f7/purple
### Week 1 · Build
- [ ] Easy run 8 km due:2026-10-12 every:weekday ^demo40
  — 8 km · J-17 · Week 1 (8/50 km)
- [ ] Intervals 6 × 800 m due:2026-10-14 at:07:00 !1 ^demo41
  Warm up 15 min, then 6 × 800 m at 5 km pace, 2 min jog between.
### Week 2 · Peak
- [ ] Long run 26 km due:2026-10-18 at:09:00 ^demo42
