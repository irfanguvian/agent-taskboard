// tcal: tiny Mac Calendar CLI for taskboard (uses Apple's EventKit, so repeating meetings are included).
//
//   tcal events [days]                          today's events (+days-1 more) as JSON; refreshes calendar.json for the board
//   tcal calendars                              list calendars you can write to
//   tcal add "<title>" "YYYY-MM-DD HH:mm" <minutes> ["<calendar>"]
//                                               create an event. Calendar: given name, else one named "Focus", else your default
//   tcal delete <event-id>                      delete an event, ONLY if tcal created it
//
// Build: swiftc -O tcal.swift -o tcal -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker tcal-Info.plist
import EventKit
import Foundation

let MARKER = "[taskboard]"
let boardDir = ProcessInfo.processInfo.environment["TASKBOARD_DIR"] ?? (NSHomeDirectory() + "/.taskboard")

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func printJSON(_ obj: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
        let s = String(data: data, encoding: .utf8) else { fail("could not encode JSON") }
  print(s)
}

// ---- access ----
final class Flag: @unchecked Sendable { var ok = false }

func openStore() -> EKEventStore {
  let probe = EKEventStore()
  let flag = Flag()
  let sem = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    probe.requestFullAccessToEvents { granted, _ in flag.ok = granted; sem.signal() }
  } else {
    probe.requestAccess(to: .event) { granted, _ in flag.ok = granted; sem.signal() }
  }
  if sem.wait(timeout: .now() + 120) == .timedOut { fail("Timed out waiting for calendar permission.") }
  if !flag.ok {
    fail("No calendar access. Allow it in System Settings > Privacy & Security > Calendars (Full Access) for your terminal app, then retry.")
  }
  return EKEventStore() // fresh store so calendars show up right after the first grant
}

let store = openStore()

// ---- helpers ----
let isoOut: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.timeZone = .current
  f.formatOptions = [.withInternetDateTime]
  return f
}()

let dateIn: DateFormatter = {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  f.dateFormat = "yyyy-MM-dd HH:mm"
  return f
}()

func fetchEvents(days: Int) -> [[String: Any]] {
  let cal = Calendar.current
  let start = cal.startOfDay(for: Date())
  let end = cal.date(byAdding: .day, value: max(days, 1), to: start)!
  let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  return store.events(matching: pred)
    .sorted { $0.compareStartDate(with: $1) == .orderedAscending }
    .map { e in
      [
        "id": e.eventIdentifier ?? "",
        "title": e.title ?? "(no title)",
        "start": isoOut.string(from: e.startDate),
        "end": isoOut.string(from: e.endDate),
        "allDay": e.isAllDay,
        "calendar": e.calendar?.title ?? "",
        "fromTaskboard": (e.notes ?? "").contains(MARKER),
      ] as [String: Any]
    }
}

func writeSnapshot() {
  let obj: [String: Any] = ["updated": isoOut.string(from: Date()), "events": fetchEvents(days: 1)]
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return }
  try? FileManager.default.createDirectory(atPath: boardDir, withIntermediateDirectories: true)
  try? data.write(to: URL(fileURLWithPath: boardDir + "/calendar.json"), options: .atomic)
}

func pickCalendar(_ name: String?) -> EKCalendar {
  let writable = store.calendars(for: .event).filter { $0.allowsContentModifications }
  if let name = name, !name.isEmpty {
    guard let c = writable.first(where: { $0.title == name }) else {
      fail("No writable calendar named \"\(name)\". Run: tcal calendars")
    }
    return c
  }
  if let focus = writable.first(where: { $0.title == "Focus" }) { return focus }
  guard let def = store.defaultCalendarForNewEvents else { fail("No default calendar. Pass a calendar name.") }
  return def
}

// ---- commands ----
let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "help"

switch cmd {
case "events":
  let days = args.count > 2 ? (Int(args[2]) ?? 1) : 1
  printJSON(fetchEvents(days: days))
  writeSnapshot()

case "calendars":
  printJSON(store.calendars(for: .event).map { c in
    ["title": c.title, "account": c.source?.title ?? "", "writable": c.allowsContentModifications] as [String: Any]
  })

case "add":
  guard args.count >= 5 else { fail("usage: tcal add \"<title>\" \"YYYY-MM-DD HH:mm\" <minutes> [\"<calendar>\"]") }
  guard let start = dateIn.date(from: args[3]) else { fail("Bad start time \"\(args[3])\". Use YYYY-MM-DD HH:mm") }
  guard let minutes = Int(args[4]), minutes > 0, minutes <= 12 * 60 else { fail("Minutes must be 1-720") }
  let ev = EKEvent(eventStore: store)
  ev.title = args[2]
  ev.startDate = start
  ev.endDate = start.addingTimeInterval(Double(minutes) * 60)
  ev.calendar = pickCalendar(args.count > 5 ? args[5] : nil)
  ev.notes = MARKER
  do {
    try store.save(ev, span: .thisEvent, commit: true)
  } catch {
    fail("Could not save event: \(error.localizedDescription)")
  }
  printJSON(["id": ev.eventIdentifier ?? "", "title": ev.title ?? "", "start": isoOut.string(from: ev.startDate),
             "end": isoOut.string(from: ev.endDate), "calendar": ev.calendar?.title ?? ""])
  writeSnapshot()

case "delete":
  guard args.count >= 3 else { fail("usage: tcal delete <event-id>") }
  guard let ev = store.event(withIdentifier: args[2]) else { fail("Event not found.") }
  guard (ev.notes ?? "").contains(MARKER) else { fail("Refusing: this event was not created by taskboard.") }
  do {
    try store.remove(ev, span: .thisEvent, commit: true)
  } catch {
    fail("Could not delete event: \(error.localizedDescription)")
  }
  print("deleted")
  writeSnapshot()

default:
  print("""
  tcal events [days]
  tcal calendars
  tcal add "<title>" "YYYY-MM-DD HH:mm" <minutes> ["<calendar>"]
  tcal delete <event-id>
  """)
  exit(cmd == "help" ? 0 : 1)
}
