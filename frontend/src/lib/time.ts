/**
 * Local slot/day labels -- slots are UTC epoch seconds end to end (the
 * spec's own "Always" rule); this is the one place they become the
 * viewer's local wall-clock time, with an explicit day label
 * (EXPERIENCE.md: `Sep 18, 2026 · 2:00 PM`).
 */

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

export function formatSlotTime(startsAt: number): string {
  return new Date(startsAt * 1000).toLocaleTimeString(undefined, TIME_FORMAT);
}

export function formatSlotDay(startsAt: number): string {
  return new Date(startsAt * 1000).toLocaleDateString(undefined, DAY_FORMAT);
}

/**
 * The short day label a slot chip carries when it has no day heading
 * above it (Discover v2's own card slots: "Today 17:30", "Sat 11:00") --
 * "Today" for the viewer's own local calendar day, otherwise a short
 * weekday name. Distinct from {@link formatSlotDay}'s longer heading form
 * (`Fri, Oct 3`), which already tells same-hour slots on different days
 * apart on its own.
 */
export function formatSlotDayShort(startsAt: number): string {
  const date = new Date(startsAt * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return isToday ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" });
}

export interface SlotDayGroup {
  dayLabel: string;
  slots: number[];
}

/** Groups already-ascending slots by the viewer's local calendar day,
 * preserving ascending order within and across groups. */
export function groupSlotsByDay(slots: number[]): SlotDayGroup[] {
  const groups: SlotDayGroup[] = [];
  for (const slot of slots) {
    const dayLabel = formatSlotDay(slot);
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.dayLabel === dayLabel) {
      currentGroup.slots.push(slot);
    } else {
      groups.push({ dayLabel, slots: [slot] });
    }
  }
  return groups;
}
