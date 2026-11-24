// Twizzle admin: manual data entry (events, disciplines, segments, athletes,
// entries, results). Protection lives in the database: RLS + admin-only RPCs
// that require profiles.is_admin for an email (non-guest) user.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';

const cfg = window.ICE_GOES_ADMIN;
const app = document.getElementById('app');
const who = document.getElementById('who');
const tabs = document.getElementById('tabs');
const toastEl = document.getElementById('toast');

const DISCIPLINES = [
  ['MS', 'Men'],
  ['WS', 'Women'],
  ['PR', 'Pairs'],
  ['ID', 'Ice Dance'],
];
const DISC_NAME = Object.fromEntries(DISCIPLINES);
const SEGMENTS = { MS: ['SP', 'FS'], WS: ['SP', 'FS'], PR: ['SP', 'FS'], ID: ['RD', 'FD'] };
const SEG_NAME = { SP: 'Short Program', FS: 'Free Skating', RD: 'Rhythm Dance', FD: 'Free Dance' };
const LEVELS = [
  ['grand_prix', 'Grand Prix', 1],
  ['grand_prix_final', 'Grand Prix Final', 1.5],
  ['challenger', 'Challenger', 1],
  ['europeans', 'European Championships', 2],
  ['four_continents', 'Four Continents', 1],
  ['worlds', 'World Championships', 3],
  ['nationals', 'National Championships', 1],
  ['junior', 'Juniors (World Juniors, Junior GP Final)', 1],
  ['team_trophy', 'World Team Trophy', 1.5],
];
const LEVEL_NAME = Object.fromEntries(LEVELS.map(([k, n]) => [k, n]));
const LEVEL_MULT = Object.fromEntries(LEVELS.map(([k, , m]) => [k, m]));

let sb;
const state = { tab: 'events', eventId: null, resultsSeg: {}, zone: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(msg, error = false) {
  toastEl.textContent = msg;
  toastEl.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 3200);
}

async function q(promise, okMsg) {
  const { data, error } = await promise;
  if (error) {
    toast(error.message, true);
    throw error;
  }
  if (okMsg) toast(okMsg);
  return data;
}

const form = (el) => Object.fromEntries(new FormData(el).entries());
const nul = (v) => (v === '' || v === undefined ? null : v);

// timestamptz <-> <input type=datetime-local> in the venue's time zone (IANA, e.g.
// Asia/Tokyo) when the event has one, else in the admin's own time zone.
const validZone = (z) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
const offsetAt = (zone, ms) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
};
const toLocalInput = (iso, zone) => {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  const off = zone ? offsetAt(zone, ms) : -new Date(ms).getTimezoneOffset() * 60000;
  return new Date(ms + off).toISOString().slice(0, 16);
};
const fromLocalInput = (v, zone) => {
  if (!v) return null;
  if (!zone) return new Date(v).toISOString();
  const wall = Date.parse(`${v}:00Z`);
  let ms = wall - offsetAt(zone, wall);
  ms = wall - offsetAt(zone, ms); // settles daylight-saving changes
  return new Date(ms).toISOString();
};
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function memberNames(entry) {
  return entry.entry_members.map((m) => m.athletes?.name ?? '?').join(' / ');
}

// ---------------------------------------------------------------------------
// Boot and sign-in (email + 6-digit code, existing admin accounts only)
// ---------------------------------------------------------------------------

async function boot() {
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey || cfg.supabaseUrl.includes('YOUR-PROJECT')) {
    app.innerHTML = `<section class="card"><h2>Setup needed</h2>
      <p class="muted">Copy <b>admin/config.example.js</b> to <b>admin/config.js</b> and add your Supabase URL and anon key.</p></section>`;
    return;
  }
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, storageKey: 'ice-goes-admin' },
  });
  const { data } = await sb.auth.getSession();
  if (!data.session || data.session.user.is_anonymous) return renderSignIn();

  const isAdmin = await q(sb.rpc('is_admin'));
  who.innerHTML = `<span>${esc(data.session.user.email)}</span><button class="quiet" id="signout">Sign out</button>`;
  document.getElementById('signout').onclick = async () => {
    await sb.auth.signOut();
    location.reload();
  };
  if (!isAdmin) {
    app.innerHTML = `<section class="card"><h2>Not an admin</h2>
      <p class="muted">This account can sign in but has no admin rights. See supabase/README.md, "Make yourself admin".</p></section>`;
    return;
  }
  tabs.hidden = false;
  tabs.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      state.eventId = null;
      tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    };
  });
  render();
}

function renderSignIn() {
  app.innerHTML = `<section class="card" style="max-width:420px">
    <h2>Sign in</h2>
    <p class="muted small">Admins only. We email you a sign-in link (or a 6-digit code once custom email is set up).
      Open the link in this browser.</p>
    <form id="emailForm" class="row">
      <label style="flex:1">Email <input name="email" type="email" required autocomplete="email"></label>
      <button class="primary">Send code</button>
    </form>
    <form id="codeForm" class="row" hidden>
      <label style="flex:1">Code <input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code"></label>
      <button class="primary">Sign in</button>
    </form>
  </section>`;
  let email = '';
  document.getElementById('emailForm').onsubmit = async (e) => {
    e.preventDefault();
    email = form(e.target).email.trim();
    // The page is public (GitHub Pages), so it never creates users: only
    // existing admin accounts get a code. Players have no email at all.
    await q(
      sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      }),
      'Check your email',
    );
    document.getElementById('codeForm').hidden = false;
  };
  document.getElementById('codeForm').onsubmit = async (e) => {
    e.preventDefault();
    await q(sb.auth.verifyOtp({ email, token: form(e.target).code.trim(), type: 'email' }));
    location.reload();
  };
}

function render() {
  if (state.tab === 'athletes') return renderAthletes();
  if (state.tab === 'settings') return renderSettings();
  if (state.tab === 'media') return renderMedia();
  return state.eventId ? renderEvent(state.eventId) : renderEvents();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function renderEvents() {
  const events = await q(
    sb.from('events').select('*, event_disciplines(discipline, status)').order('start_date', { ascending: false }),
  );
  app.innerHTML = `<section class="card">
      <div class="spread"><h2>Events</h2><button class="primary" id="newEvent">New event</button></div>
      <div id="eventFormSlot"></div>
      <table>
        <thead><tr><th>Event</th><th>Level</th><th>Dates</th><th>×</th><th>Disciplines</th><th></th></tr></thead>
        <tbody>${events
          .map(
            (e) => `<tr class="click" data-id="${e.id}">
              <td><b>${esc(e.name)}</b><div class="muted small">${esc([e.city, e.country].filter(Boolean).join(', '))}</div></td>
              <td>${esc(LEVEL_NAME[e.level])}</td>
              <td>${esc(e.start_date)} – ${esc(e.end_date)}</td>
              <td>${esc(e.multiplier)}</td>
              <td>${e.event_disciplines
                .map((d) => `<span class="chip ${d.status === 'scheduled' ? '' : d.status}">${d.discipline}</span>`)
                .join(' ')}</td>
              <td>${e.needs_review ? '<span class="chip review">review</span>' : ''} ${e.is_demo ? '<span class="chip demo">demo</span>' : ''}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>`;
  app.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => {
      state.eventId = tr.dataset.id;
      render();
    };
  });
  document.getElementById('newEvent').onclick = () => {
    const slot = document.getElementById('eventFormSlot');
    slot.innerHTML = eventFormHtml({});
    bindEventForm(slot.querySelector('form'), null);
  };
}

function eventFormHtml(e, coverOptions = null) {
  const level = e.level ?? 'grand_prix';
  return `<form class="card" id="eventForm">
    <div class="grid">
      <label>Name <input name="name" required minlength="3" value="${esc(e.name)}"></label>
      <label>Series <input name="series" value="${esc(e.series)}" placeholder="Grand Prix"></label>
      <label>Level <select name="level">${LEVELS.map(
        ([k, n]) => `<option value="${k}" ${k === level ? 'selected' : ''}>${n}</option>`,
      ).join('')}</select></label>
      <label>Multiplier <input name="multiplier" type="number" step="0.5" min="0.5" max="5" required value="${esc(e.multiplier ?? LEVEL_MULT[level])}"></label>
      <label>Season <input name="season" required pattern="\\d{4}-\\d{2}" value="${esc(e.season ?? '2026-27')}"></label>
      <label>Start date <input name="start_date" type="date" required value="${esc(e.start_date)}"></label>
      <label>End date <input name="end_date" type="date" required value="${esc(e.end_date)}"></label>
      <label>Venue <input name="venue" value="${esc(e.venue)}"></label>
      <label>City <input name="city" value="${esc(e.city)}"></label>
      <label>Country (3 letters) <input name="country" maxlength="3" pattern="[A-Z]{3}" value="${esc(e.country)}"></label>
      <label>Venue time zone <input name="timezone" placeholder="e.g. Asia/Tokyo" value="${esc(e.timezone)}"></label>
      <label>Source name <input name="source_name" value="${esc(e.source_name)}"></label>
      <label>Source link <input name="source_url" type="url" value="${esc(e.source_url)}"></label>
    </div>
    ${coverOptions ? `<div class="row"><label style="flex:1">Cover skater (photo on the calendar and event page)
      <select name="cover_athlete"><option value="">Automatic: rotates across disciplines</option>${coverOptions
        .map((o) => `<option value="${o.id}" ${o.id === e.cover_athlete ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select></label></div>` : ''}
    <div class="row">
      <label class="check"><input type="checkbox" name="needs_review" ${e.needs_review ? 'checked' : ''}> Needs review</label>
      <label style="flex:1">Review note <input name="review_note" value="${esc(e.review_note)}"></label>
    </div>
    <div class="row"><button class="primary">${e.id ? 'Save event' : 'Create event'}</button></div>
  </form>`;
}

function bindEventForm(el, id) {
  el.level.onchange = () => (el.multiplier.value = LEVEL_MULT[el.level.value]);
  el.country.oninput = () => (el.country.value = el.country.value.toUpperCase());
  el.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = form(el);
    const row = {
      name: f.name.trim(),
      series: nul(f.series),
      level: f.level,
      multiplier: Number(f.multiplier),
      season: f.season,
      start_date: f.start_date,
      end_date: f.end_date,
      venue: nul(f.venue),
      city: nul(f.city),
      country: nul(f.country),
      timezone: nul(f.timezone?.trim()),
      source_name: nul(f.source_name),
      source_url: nul(f.source_url),
      needs_review: !!f.needs_review,
      review_note: nul(f.review_note),
    };
    if ('cover_athlete' in f) row.cover_athlete = f.cover_athlete || null;
    if (row.timezone && !validZone(row.timezone)) return toast(`Unknown time zone ${row.timezone}. Use a name like Europe/Helsinki.`, true);
    if (id) {
      await q(sb.from('events').update(row).eq('id', id), 'Event saved');
    } else {
      const created = await q(sb.from('events').insert(row).select('id').single(), 'Event created');
      state.eventId = created.id;
    }
    render();
  };
}

/** Entered skaters who have a photo, for the cover picker. */
function coverOptionsOf(event) {
  const seen = new Map();
  for (const d of event.event_disciplines) {
    for (const en of d.entries ?? []) {
      if (en.withdrawn) continue;
      for (const m of en.entry_members ?? []) {
        if (!m.athletes?.photos?.length || seen.has(m.athlete_id)) continue;
        seen.set(m.athlete_id, { id: m.athlete_id, label: `${m.athletes.name} · ${d.discipline}` });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function renderEvent(id) {
  const [event, athletes] = await Promise.all([
    q(
      sb
        .from('events')
        .select(
          `*, event_disciplines(*, segments(*), entries(*, entry_members(athlete_id, athletes(name, country, photos(id))), results(*)))`,
        )
        .eq('id', id)
        .single(),
    ),
    q(sb.from('athletes').select('id, name, country').order('name').limit(5000)),
  ]);

  const byDisc = Object.fromEntries(event.event_disciplines.map((d) => [d.discipline, d]));
  state.zone = event.timezone && validZone(event.timezone) ? event.timezone : null;
  app.innerHTML = `
    <div class="row"><button class="quiet" id="back">← All events</button></div>
    <section class="card">
      <div class="spread"><h2>${esc(event.name)}</h2>
        <span>${event.is_demo ? '<span class="chip demo">demo</span>' : ''} ${event.needs_review ? '<span class="chip review">needs review</span>' : ''}</span></div>
      ${eventFormHtml(event, coverOptionsOf(event))}
    </section>
    <datalist id="athleteList">${athletes
      .map((a) => `<option value="${esc(a.name)}${a.country ? ` (${esc(a.country)})` : ''}" data-id="${a.id}">`)
      .join('')}</datalist>
    ${DISCIPLINES.map(([code, name]) =>
      byDisc[code]
        ? disciplineHtml(byDisc[code], name)
        : `<section class="card"><div class="spread"><h3>${name}</h3>
            <button data-add-disc="${code}">Add ${name}</button></div></section>`,
    ).join('')}`;

  document.getElementById('back').onclick = () => {
    state.eventId = null;
    render();
  };
  bindEventForm(document.getElementById('eventForm'), id);

  const athleteIdByLabel = new Map(
    athletes.map((a) => [`${a.name}${a.country ? ` (${a.country})` : ''}`, a.id]),
  );

  app.querySelectorAll('[data-add-disc]').forEach((b) => {
    b.onclick = async () => {
      await q(sb.from('event_disciplines').insert({ event_id: id, discipline: b.dataset.addDisc }), 'Discipline added');
      render();
    };
  });

  for (const d of event.event_disciplines) bindDiscipline(d, athleteIdByLabel);
}

function disciplineHtml(d, name) {
  const team = d.discipline === 'PR' || d.discipline === 'ID';
  const segByKind = Object.fromEntries(d.segments.map((s) => [s.kind, s]));
  const entries = [...d.entries].sort((a, b) => memberNames(a).localeCompare(memberNames(b)));
  const resultKey = state.resultsSeg[d.id] ?? (d.segments[0]?.id ?? 'overall');
  return `<section class="card" data-disc="${d.id}">
    <div class="spread">
      <h3>${name} <span class="chip ${d.status === 'scheduled' ? '' : d.status}">${d.status}</span></h3>
      <div class="row">
        <select data-status>${['scheduled', 'live']
          .map((s) => `<option ${s === d.status ? 'selected' : ''}>${s}</option>`)
          .join('')}${d.status === 'final' ? '<option selected>final</option>' : ''}</select>
        <button data-final>${d.status === 'final' ? 'Re-score' : 'Mark results final'}</button>
      </div>
    </div>

    <div class="disc">
      <h3>Segments <span class="muted small">(${state.zone ? `venue time, ${esc(state.zone)}` : 'your own time: set the venue time zone above'};
        picks open 3 days before the first start and close 3 hours before it)</span></h3>
      <div class="row">${SEGMENTS[d.discipline]
        .map(
          (k) => `<label>${SEG_NAME[k]}${segByKind[k]?.estimated ? ' <span class="chip review">estimate</span>' : ''}
            <input type="datetime-local" data-seg-kind="${k}" value="${toLocalInput(segByKind[k]?.starts_at, state.zone)}"></label>`,
        )
        .join('')}<button data-save-segs>Save times</button></div>
    </div>

    <div class="disc">
      <h3>Entries (${entries.length})</h3>
      <table><thead><tr><th>${team ? 'Team' : 'Skater'}</th><th>Withdrawn</th><th></th></tr></thead><tbody>
        ${entries
          .map(
            (e) => `<tr><td>${esc(memberNames(e))} <span class="muted small">${esc(
              e.entry_members[0]?.athletes?.country ?? '',
            )}</span></td>
            <td><input type="checkbox" data-withdraw="${e.id}" ${e.withdrawn ? 'checked' : ''}></td>
            <td><button class="quiet" data-del-entry="${e.id}">Remove</button></td></tr>`,
          )
          .join('')}
      </tbody></table>
      <form class="row" data-add-entry>
        <label style="flex:1">${team ? 'Partner 1' : 'Athlete'} <input name="a1" list="athleteList" required></label>
        ${team ? '<label style="flex:1">Partner 2 <input name="a2" list="athleteList" required></label>' : ''}
        <button>Add entry</button>
      </form>
      <p class="muted small">Not in the list? Add the athlete on the Athletes tab first.</p>
    </div>

    <div class="disc">
      <div class="spread"><h3>Results</h3>
        <select data-results-seg>
          ${d.segments
            .map((s) => `<option value="${s.id}" ${resultKey === s.id ? 'selected' : ''}>${SEG_NAME[s.kind]}</option>`)
            .join('')}
          <option value="overall" ${resultKey === 'overall' ? 'selected' : ''}>Overall (final placement)</option>
        </select></div>
      <table><thead><tr><th>${team ? 'Team' : 'Skater'}</th><th>Place</th><th>Score</th></tr></thead><tbody>
        ${entries
          .map((e) => {
            const r = e.results.find((x) => (resultKey === 'overall' ? x.segment_id === null : x.segment_id === resultKey));
            return `<tr><td>${esc(memberNames(e))}</td>
              <td><input type="number" min="1" max="99" data-rank="${e.id}" value="${r?.rank ?? ''}"></td>
              <td><input type="number" step="0.01" min="0" data-score="${e.id}" value="${r?.score ?? ''}"></td></tr>`;
          })
          .join('')}
      </tbody></table>
      <div class="row"><button class="primary" data-save-results>Save results</button>
        <span class="muted small">Leave a place empty to skip that entry.</span></div>
    </div>
  </section>`;
}

function bindDiscipline(d, athleteIdByLabel) {
  const root = app.querySelector(`[data-disc="${d.id}"]`);
  const $ = (sel) => root.querySelector(sel);

  $('[data-status]').onchange = async (e) => {
    if (e.target.value === 'final') return;
    await q(sb.from('event_disciplines').update({ status: e.target.value }).eq('id', d.id), 'Status saved');
    render();
  };
  $('[data-final]').onclick = async () => {
    const again = d.status === 'final';
    if (!confirm(again ? 'Score this discipline again with the current results?' : 'Mark these results final? Ice XP is scored right away.')) return;
    await q(sb.rpc('admin_set_final', { ed_id: d.id }), again ? 'Re-scored' : 'Marked final and scored');
    render();
  };

  $('[data-save-segs]').onclick = async () => {
    const rows = [...root.querySelectorAll('[data-seg-kind]')]
      .filter((i) => i.value)
      .map((i) => ({ event_discipline_id: d.id, kind: i.dataset.segKind, starts_at: fromLocalInput(i.value, state.zone), estimated: false }));
    if (!rows.length) return toast('Enter at least one start time', true);
    await q(sb.from('segments').upsert(rows, { onConflict: 'event_discipline_id,kind' }), 'Times saved');
    render();
  };

  root.querySelectorAll('[data-withdraw]').forEach((cb) => {
    cb.onchange = () => q(sb.from('entries').update({ withdrawn: cb.checked }).eq('id', cb.dataset.withdraw), 'Saved');
  });
  root.querySelectorAll('[data-del-entry]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this entry and its results?')) return;
      await q(sb.from('entries').delete().eq('id', b.dataset.delEntry), 'Entry removed');
      render();
    };
  });

  $('[data-add-entry]').onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    const ids = [f.a1, f.a2].filter((v) => v !== undefined).map((label) => athleteIdByLabel.get(label.trim()));
    if (ids.some((x) => !x)) return toast('Pick athletes from the list', true);
    await q(sb.rpc('admin_add_entry', { ed_id: d.id, athlete_ids: ids }), 'Entry added');
    render();
  };

  $('[data-results-seg]').onchange = (e) => {
    state.resultsSeg[d.id] = e.target.value;
    render();
  };
  $('[data-save-results]').onclick = async () => {
    const segKey = $('[data-results-seg]').value;
    const rows = [...root.querySelectorAll('[data-rank]')]
      .filter((i) => i.value)
      .map((i) => ({
        entry_id: i.dataset.rank,
        rank: Number(i.value),
        score: root.querySelector(`[data-score="${i.dataset.rank}"]`).value,
      }));
    await q(
      sb.rpc('admin_save_results', {
        ed_id: d.id,
        seg_id: segKey === 'overall' ? null : segKey,
        rows,
        src: 'manual',
      }),
      `Saved ${rows.length} results`,
    );
    state.resultsSeg[d.id] = segKey;
    render();
  };
}

// ---------------------------------------------------------------------------
// Athletes
// ---------------------------------------------------------------------------

async function renderAthletes(search = '', openId = null) {
  let query = sb.from('athletes').select('*, photos(id, url, credit, license, license_url, source_url, origin, width, height, focus_x, focus_y)').order('name').limit(200);
  if (search) query = query.or(`name.ilike.%${search.replace(/[,()]/g, ' ')}%,name_ru.ilike.%${search.replace(/[,()]/g, ' ')}%`);
  const athletes = await q(query);
  app.innerHTML = `<section class="card">
    <h2>Athletes</h2>
    <form class="row" id="athleteForm">
      <input type="hidden" name="id">
      <label style="flex:2">Name <input name="name" required minlength="2"></label>
      <label style="flex:2">Name in Russian <input name="name_ru" placeholder="Имя Фамилия" lang="ru"></label>
      <label>Country (3 letters) <input name="country" maxlength="3" pattern="[A-Z]{3}"></label>
      <label>Birth year <input name="birth_year" type="number" min="1950" max="2020"></label>
      <button class="primary" id="athleteSubmit">Add athlete</button>
      <button type="button" class="quiet" id="athleteCancel" hidden>Cancel edit</button>
    </form>
    <p class="muted small">Facts only: name, country, birth year. The Russian name is shown when the app is in Russian; imports fill it only while it is empty. Photos need a licence and credit per image.</p>
    <div id="photoPanel"></div>
    <div class="row"><label style="flex:1">Search <input id="search" value="${esc(search)}"></label></div>
    <table><thead><tr><th>Name</th><th>Country</th><th>Born</th><th>Photo</th><th></th></tr></thead><tbody>
      ${athletes
        .map(
          (a) => `<tr class="click" data-id="${a.id}"><td><b>${esc(a.name)}</b>${a.name_ru ? `<br><span class="muted small">${esc(a.name_ru)}</span>` : ''}</td><td>${esc(a.country)}</td>
            <td>${esc(a.birth_year)}</td><td>${a.photos.length ? '✓' : '—'}</td>
            <td>${a.is_demo ? '<span class="chip demo">demo</span>' : ''}</td></tr>`,
        )
        .join('')}
    </tbody></table>
  </section>`;

  const f = document.getElementById('athleteForm');
  f.country.oninput = () => (f.country.value = f.country.value.toUpperCase());
  let timer;
  document.getElementById('search').oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => renderAthletes(e.target.value.trim()), 300);
  };
  app.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => {
      const a = athletes.find((x) => x.id === tr.dataset.id);
      f.id.value = a.id;
      f.name.value = a.name;
      f.name_ru.value = a.name_ru ?? '';
      f.country.value = a.country ?? '';
      f.birth_year.value = a.birth_year ?? '';
      document.getElementById('athleteSubmit').textContent = 'Save athlete';
      document.getElementById('athleteCancel').hidden = false;
      renderPhotoPanel(a, search);
      f.name.focus();
    };
  });
  document.getElementById('athleteCancel').onclick = () => renderAthletes(search);
  if (openId) app.querySelector(`tr[data-id="${openId}"]`)?.click(); // keep the photo panel open after a change
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = form(f);
    const row = { name: v.name.trim(), name_ru: nul(v.name_ru?.trim()), country: nul(v.country), birth_year: v.birth_year ? Number(v.birth_year) : null };
    if (v.id) await q(sb.from('athletes').update(row).eq('id', v.id), 'Athlete saved');
    else await q(sb.from('athletes').insert(row), 'Athlete added');
    renderAthletes(search);
  };
}

// Photos: Wikimedia Commons files with a free licence only (same rule as the importer).
const FREE_LICENCE = (s) => !/\b(NC|ND)\b/i.test(s) && /^(CC0|Public domain|PD\b|CC[- ]BY(-SA)?( \d(\.\d)?)?\b)/i.test(s.trim());
// DOMParser documents run no scripts and load no images, unlike innerHTML.
const plainText = (html) =>
  new DOMParser().parseFromString(html ?? '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);

/** "https://commons.wikimedia.org/wiki/File:X.jpg" -> photo row fields, or an error message. */
async function commonsPhoto(link) {
  const m = String(link).match(/(?:^|\/wiki\/|title=)(File:[^?#&]+)/i) ?? String(link).match(/^(File:.+)$/i);
  if (!m) return { error: 'Paste a Commons file link like https://commons.wikimedia.org/wiki/File:Name.jpg' };
  const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=500' +
    `&format=json&formatversion=2&origin=*&titles=${encodeURIComponent(title)}`;
  const page = (await (await fetch(api)).json()).query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!info) return { error: 'File not found on Commons.' };
  const meta = info.extmetadata ?? {};
  const license = plainText(meta.LicenseShortName?.value);
  if (meta.NonFree?.value === 'true' || !FREE_LICENCE(license)) return { error: `Licence "${license || 'unknown'}" is not allowed (CC0, public domain, CC BY, CC BY-SA only).` };
  const artist = plainText(meta.Artist?.value) || 'Unknown author';
  return {
    url: (info.thumburl ?? info.url).split('?')[0],
    credit: /wikimedia commons/i.test(artist) ? artist : `${artist}, Wikimedia Commons`,
    license,
    license_url: meta.LicenseUrl?.value || null,
    source_url: info.descriptionurl,
    width: info.thumbwidth ?? null,
    height: info.thumbheight ?? null,
  };
}

function renderPhotoPanel(a, search) {
  const panel = document.getElementById('photoPanel');
  panel.innerHTML = `<div class="disc"><h3>Photo of ${esc(a.name)}</h3>
    ${a.photos
      .map(
        (p) => `<div class="row" style="align-items:flex-start">
          <div style="position:relative;display:inline-block">
            <img src="${esc(p.url)}" alt="" data-focus="${p.id}" title="Click the face: it becomes the centre of the circle in the app"
              style="max-width:220px;max-height:220px;cursor:crosshair;border-radius:8px;display:block">
            ${p.focus_x != null ? `<span style="position:absolute;left:${p.focus_x * 100}%;top:${p.focus_y * 100}%;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid #7CF5D8;border-radius:7px;pointer-events:none"></span>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:center">
            <div style="width:96px;height:96px;border-radius:48px;background-image:url('${esc(p.url)}');background-size:cover;
              background-position:${(p.focus_x ?? 0.5) * 100}% ${(p.focus_y ?? (p.height > p.width ? 0.03 : 0.5)) * 100}%"></div>
            <span class="muted small">in the app</span>
          </div>
          <span class="small" style="flex:1">${esc(p.credit)} · ${esc(p.license)} · <a href="${esc(p.source_url)}" target="_blank" rel="noopener">file</a><br>
          <span class="chip">${p.origin === 'manual' ? 'added by hand (shown first)' : 'from Wikidata'}</span>
          ${p.focus_x != null ? '<span class="chip">face set</span>' : '<span class="muted">Click the face on the photo if the circle cuts it off.</span>'}</span>
          ${p.origin === 'manual' ? `<button class="quiet" data-del-photo="${p.id}">Remove</button>` : ''}</div>`,
      )
      .join('') || '<p class="muted small">No photo yet.</p>'}
    <div class="row"><label style="flex:1">Wikimedia Commons file link <input id="commonsLink" placeholder="https://commons.wikimedia.org/wiki/File:..."></label>
      <button id="addPhoto">Add photo</button></div>
    <p class="muted small">Only CC0, public domain, CC BY or CC BY-SA files. The app shows the author and licence with the photo. Other sources need written permission.</p></div>`;
  panel.querySelectorAll('img[data-focus]').forEach((img) => {
    img.onclick = async (e) => {
      const r = img.getBoundingClientRect();
      const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
      const focus = { focus_x: round((e.clientX - r.left) / r.width), focus_y: round((e.clientY - r.top) / r.height) };
      // remember the size too, for photos saved before sizes were stored
      const size = img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {};
      await q(sb.from('photos').update({ ...focus, ...size }).eq('id', img.dataset.focus), 'Face position saved');
      renderAthletes(search, a.id);
    };
  });
  panel.querySelectorAll('[data-del-photo]').forEach((b) => {
    b.onclick = async () => {
      await q(sb.from('photos').delete().eq('id', b.dataset.delPhoto), 'Photo removed');
      renderAthletes(search, a.id);
    };
  });
  document.getElementById('addPhoto').onclick = async () => {
    const r = await commonsPhoto(document.getElementById('commonsLink').value.trim());
    if (r.error) return toast(r.error, true);
    await q(sb.from('photos').insert({ athlete_id: a.id, origin: 'manual', ...r }), 'Photo added');
    renderAthletes(search, a.id);
  };
}

// ---------------------------------------------------------------------------
// Settings (tunable XP rules, landed-quad rule)
// ---------------------------------------------------------------------------

async function renderSettings() {
  const settings = await q(sb.from('app_settings').select('*').order('key'));
  app.innerHTML = settings
    .map(
      (s) => `<section class="card">
        <div class="spread"><h3>${esc(s.key)}</h3><span class="muted small">updated ${fmtDateTime(s.updated_at)}</span></div>
        <textarea data-key="${esc(s.key)}" spellcheck="false">${esc(JSON.stringify(s.value, null, 2))}</textarea>
        <div class="row"><button class="primary" data-save="${esc(s.key)}">Save</button></div>
      </section>`,
    )
    .join('');
  app.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = async () => {
      const ta = app.querySelector(`textarea[data-key="${b.dataset.save}"]`);
      let value;
      try {
        value = JSON.parse(ta.value);
      } catch {
        return toast('That is not valid JSON', true);
      }
      await q(sb.from('app_settings').update({ value }).eq('key', b.dataset.save), 'Saved');
      renderSettings();
    };
  });
}

// ---------------------------------------------------------------------------
// Listen & watch: podcasts (RSS feed + Yandex Music link) and YouTube channels
// ---------------------------------------------------------------------------

const STATUS_NEXT = { approved: 'hidden', hidden: 'approved', candidate: 'approved' };

async function renderMedia() {
  const sources = await q(
    sb.from('media_sources').select('*, media_items(count)').order('status').order('lang').order('title'),
  );
  const row = (s) => `<tr>
      <td><b>${esc(s.title)}</b><br><span class="muted small">${esc(s.kind === 'podcast' ? s.feed_url : s.channel_ref)}</span></td>
      <td>${s.kind}</td><td>${s.lang}</td>
      <td><span class="chip${s.status === 'approved' ? '' : ' demo'}">${s.status}</span></td>
      <td>${s.media_items?.[0]?.count ?? 0}${s.fetched_at ? `<br><span class="muted small">${fmtDateTime(s.fetched_at)}</span>` : ''}
        ${s.last_error ? `<br><span class="small" style="color:var(--orange)">${esc(s.last_error)}</span>` : ''}</td>
      <td>${s.listen_url ? `<a href="${esc(s.listen_url)}" target="_blank" rel="noopener">open</a>` : ''}</td>
      <td class="row">
        <button class="quiet" data-status="${s.id}" data-next="${STATUS_NEXT[s.status]}">${s.status === 'approved' ? 'Hide' : 'Approve'}</button>
        <button class="quiet" data-delete="${s.id}">Delete</button>
      </td></tr>`;
  app.innerHTML = `<section class="card">
    <h2>Listen &amp; watch</h2>
    <p class="muted small">Only approved sources show in the app, in their language. Items are links: title, date, length.
      Podcasts update every 3 hours from their RSS feed; YouTube channels need YOUTUBE_API_KEY in ingest/.env.
      A new podcast host must be added to the registry (ingest/sources.mjs, podcast_feeds).</p>
    <form class="row" id="podcastForm">
      <label style="flex:2">Podcast title <input name="title" required minlength="2"></label>
      <label style="flex:3">RSS feed (https) <input name="feed_url" required pattern="https://.+" placeholder="https://cloud.mave.digital/33679"></label>
      <label style="flex:3">Listen link (Yandex Music) <input name="listen_url" pattern="https://.+" placeholder="https://music.yandex.ru/album/..."></label>
      <label>Language <select name="lang"><option value="ru">Russian</option><option value="en">English</option></select></label>
      <button class="primary">Add podcast</button>
    </form>
    <form class="row" id="channelForm">
      <label style="flex:2">Channel title <input name="title" required minlength="2"></label>
      <label style="flex:3">YouTube link or @handle <input name="ref" required placeholder="https://www.youtube.com/@paolala"></label>
      <label>Language <select name="lang"><option value="en">English</option><option value="ru">Russian</option></select></label>
      <button class="primary">Add channel</button>
    </form>
    <table><thead><tr><th>Source</th><th>Kind</th><th>Lang</th><th>Status</th><th>Items</th><th></th><th></th></tr></thead>
      <tbody>${sources.map(row).join('')}</tbody></table>
  </section>`;

  document.getElementById('podcastForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = form(e.target);
    await q(sb.from('media_sources').insert({ kind: 'podcast', title: v.title.trim(), lang: v.lang, feed_url: v.feed_url.trim(), listen_url: nul(v.listen_url.trim()) }), 'Podcast added');
    renderMedia();
  };
  document.getElementById('channelForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = form(e.target);
    // "https://www.youtube.com/@name", "youtube.com/channel/UC...", "@name"
    const m = v.ref.trim().match(/(@[A-Za-z0-9._-]{3,100})|(UC[A-Za-z0-9_-]{22})/);
    if (!m) return toast('Paste a channel link with @name or a channel id (UC...)', true);
    const ref = m[0];
    const link = ref.startsWith('@') ? `https://www.youtube.com/${ref}` : `https://www.youtube.com/channel/${ref}`;
    await q(sb.from('media_sources').insert({ kind: 'youtube', title: v.title.trim(), lang: v.lang, channel_ref: ref, listen_url: link }), 'Channel added');
    renderMedia();
  };
  app.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = async () => {
      await q(sb.from('media_sources').update({ status: b.dataset.next }).eq('id', b.dataset.status), 'Saved');
      renderMedia();
    };
  });
  app.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this source and its items?')) return;
      await q(sb.from('media_sources').delete().eq('id', b.dataset.delete), 'Deleted');
      renderMedia();
    };
  });
}

boot().catch((e) => {
  console.error(e);
  app.innerHTML = `<section class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></section>`;
});
