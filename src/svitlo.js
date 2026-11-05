// Sends the outage schedule to the Svitlo function (Cloud Run), for every day found on the DTEK page.
import { GROUP, hours, PowerState } from "./constants.js"

const SVITLO_URL = process.env.SVITLO_URL
const SVITLO_KEY = process.env.SVITLO_KEY

function kyivDate(ms) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }) // 2026-11-03
}

// the keys of data.data are normally unix timestamps (seconds); be tolerant about other formats
function keyToDate(key, todayKey) {
  if (/^\d{9,11}$/.test(key)) return kyivDate(Number(key) * 1000)
  if (/^\d{12,14}$/.test(key)) return kyivDate(Number(key))
  if (/^\d{4}-\d{2}-\d{2}/.test(key)) return key.slice(0, 10)
  const m = key.match(/^(\d{2})\.(\d{2})\.(\d{4})/)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  if (String(key) === String(todayKey)) return kyivDate(Date.now())
  return null
}

// DTEK gives 24 hour cells: yes = power, no = off, first = off the first half hour, second = off the second half
// result: outage intervals in minutes from midnight, e.g. [[0, 330], [600, 840]]
export function outageIntervals(hoursStates) {
  const spans = []
  const add = (a, b) => {
    const last = spans.at(-1)
    if (last && last[1] === a) last[1] = b
    else spans.push([a, b])
  }
  for (const hour of hours) {
    const state = hoursStates[hour + 1]
    const start = hour * 60
    if (state === PowerState.OFF) add(start, start + 60)
    else if (state === PowerState.HALF_OFF) add(start, start + 30)
    else if (state === PowerState.HALF_ON) add(start + 30, start + 60)
  }
  return spans
}

export async function sendToSvitlo(data) {
  if (!SVITLO_URL || !SVITLO_KEY) {
    console.log("ℹ️ SVITLO_URL / SVITLO_KEY are not set, skipping Svitlo.")
    return
  }
  const days = []
  for (const [key, groups] of Object.entries(data.data ?? {})) {
    const date = keyToDate(key, data.today)
    if (!date) {
      console.log(`🟡 Unknown day key "${key}", skipped.`)
      continue
    }
    const states = groups?.[GROUP]
    if (!states) {
      console.log(`🟡 Group ${GROUP} not found for ${date}. Groups on the page: ${Object.keys(groups ?? {}).join(", ")}`)
      continue
    }
    days.push({ date, intervals: outageIntervals(states) })
  }
  if (!days.length) {
    console.log("🟡 Nothing to send to Svitlo.")
    return
  }
  const url = SVITLO_URL.replace(/\/+$/, "") + "/?action=schedule"
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Key": SVITLO_KEY },
    body: JSON.stringify({ days, group: GROUP.replace("GPV", ""), update: data.update ?? null }),
  })
  console.log(`🟢 Svitlo answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
  if (!response.ok) throw Error(`Svitlo rejected the schedule (${response.status}).`)
}
