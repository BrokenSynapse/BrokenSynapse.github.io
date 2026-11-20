const byId = id => document.getElementById(id);
const integer = control => control.valueAsNumber;
const mod = (n, d) => ((n % d) + d) % d;

function daysInMonth(calendar, year, month) {
  const leap = calendar.mode === 'gregorian' && month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leap ? 29 : calendar.months[month - 1]?.days || 1;
}

function dateLabel(calendar, date) {
  const era = calendar.eras.findLast(row => row.start <= date.year);
  const year = era ? (date.year - era.start + 1) + ' ' + era.name :
    calendar.mode === 'gregorian' && date.year <= 0 ? (1 - date.year) + ' BCE' : String(date.year);
  return calendar.months[date.month - 1].name + ' ' + date.day + ', ' + year;
}

function button(text, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.onclick = action;
  return element;
}

export function createTimeline({ request }) {
  const root = byId('channel-timeline');
  const content = byId('timeline-content');
  const status = byId('timeline-status');
  const eventDialog = byId('timeline-event');
  const timeDialog = byId('time-system');
  const eventForm = eventDialog.querySelector('form');
  const systemForm = timeDialog.querySelector('form');
  const timelineButton = byId('timeline-list-view');
  const calendarButton = byId('timeline-calendar-view');
  let conversation = null;
  let state = null;
  let version = 0;
  let view = 'timeline';
  let shownMonth = null;
  let editingEvent = null;
  let system = null;
  let customDraft = null;
  let saving = false;

  const route = id => 'conversations/' + id + '/timeline';
  const today = () => {
    const date = new Date();
    return state?.calendar.mode === 'gregorian'
      ? { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
      : { year: 1, month: 1, day: 1 };
  };

  function render() {
    if (!state) return;
    timelineButton.setAttribute('aria-pressed', String(view === 'timeline'));
    calendarButton.setAttribute('aria-pressed', String(view === 'calendar'));
    byId('timeline-time-system').hidden = !state.canManage;
    byId('timeline-add-event').hidden = !state.canCreate;
    content.replaceChildren(view === 'timeline' ? eventList() : calendarView());
  }

  function eventList() {
    const list = document.createElement('ol');
    list.className = 'timeline-events';
    for (const event of state.events) {
      const row = document.createElement('li');
      const date = document.createElement('span');
      date.className = 'timeline-date';
      date.textContent = dateLabel(state.calendar, event);
      const title = document.createElement('h3');
      title.textContent = event.title;
      row.append(date, title);
      if (event.description) {
        const body = document.createElement('p');
        body.textContent = event.description;
        row.append(body);
      }
      if (event.editable) row.append(button('Edit event', () => openEvent(event)));
      list.append(row);
    }
    if (!state.events.length) {
      const empty = document.createElement('li');
      empty.className = 'timeline-empty';
      if (state.canCreate) empty.append(button('+ Add first event', () => openEvent(null)));
      else empty.textContent = 'No events yet.';
      list.append(empty);
    }
    return list;
  }

  function calendarView() {
    const calendar = state.calendar;
    const { year, month } = shownMonth;
    const shell = document.createElement('div');
    shell.className = 'timeline-calendar';
    const controls = document.createElement('div');
    controls.className = 'calendar-controls';
    const title = document.createElement('strong');
    const label = dateLabel(calendar, { year, month, day: 1 });
    title.textContent = calendar.months[month - 1].name + ' · ' + label.slice(label.lastIndexOf(', ') + 2);
    const move = offset => {
      const index = month - 1 + offset;
      const nextYear = year + Math.floor(index / calendar.months.length);
      if (Math.abs(nextYear) > 999999) return;
      shownMonth = { year: nextYear, month: mod(index, calendar.months.length) + 1 };
      render();
    };
    const previous = button('‹', () => move(-1));
    previous.setAttribute('aria-label', 'Previous month');
    const next = button('›', () => move(1));
    next.setAttribute('aria-label', 'Next month');
    controls.append(previous, title, next);
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    grid.style.setProperty('--calendar-columns', calendar.weekdays.length);
    for (const name of calendar.weekdays) {
      const weekday = document.createElement('strong');
      weekday.textContent = name;
      grid.append(weekday);
    }
    let offset;
    if (calendar.mode === 'gregorian') {
      const date = new Date(0);
      date.setUTCFullYear(mod(year, 400), month - 1, 1);
      offset = mod(date.getUTCDay() + 6, 7);
    } else {
      const length = calendar.months.reduce((sum, part) => sum + part.days, 0);
      const prior = calendar.months.slice(0, month - 1).reduce((sum, part) => sum + part.days, 0);
      offset = mod((year - 1) * length + prior, calendar.weekdays.length);
    }
    for (let i = 0; i < offset; i++) grid.append(document.createElement('span'));
    const events = state.events.filter(event => event.year === year && event.month === month);
    for (let day = 1; day <= daysInMonth(calendar, year, month); day++) {
      const cell = document.createElement('div');
      const number = state.canCreate ? button(String(day), () => openEvent(null, { year, month, day })) : document.createElement('span');
      if (state.canCreate) number.setAttribute('aria-label', 'Add event on ' + dateLabel(calendar, { year, month, day }));
      else number.textContent = day;
      cell.append(number);
      for (const event of events.filter(event => event.day === day)) cell.append(button(event.title, () => openEvent(event)));
      grid.append(cell);
    }
    shell.append(controls, grid);
    return shell;
  }

  async function refresh() {
    if (!conversation) return;
    const id = conversation;
    const ticket = ++version;
    try {
      const data = await request(route(id));
      if (conversation !== id || ticket !== version) return;
      state = data;
      if (!shownMonth || shownMonth.month > state.calendar.months.length) shownMonth = state.events[0] || today();
      render();
    } catch (error) {
      if (conversation === id && ticket === version) status.textContent = error.message;
    }
  }

  async function change(data, dialog) {
    if (!conversation || saving) return;
    const id = conversation;
    const destination = dialog.querySelector('[role="status"]');
    const controls = [...dialog.querySelectorAll('button[type="submit"]')];
    controls.forEach(button => { button.disabled = true; });
    saving = true;
    destination.textContent = '';
    try {
      await request(route(id), data);
      if (conversation !== id) return;
      dialog.close();
      await refresh();
    } catch (error) {
      if (conversation === id) destination.textContent = error.message;
    } finally {
      controls.forEach(button => { button.disabled = false; });
      saving = false;
    }
  }

  function openEvent(event, date = event || shownMonth || today()) {
    if (!state) return;
    const editable = !event || event.editable;
    editingEvent = event;
    const { title, description, year, month, day } = eventForm.elements;
    const calendar = state.calendar;
    month.replaceChildren(...calendar.months.map((row, i) => new Option(row.name, i + 1)));
    title.value = event?.title ?? '';
    description.value = event?.description ?? '';
    year.value = date.year;
    month.value = date.month;
    day.value = date.day || 1;
    function limitDay() { day.max = daysInMonth(calendar, integer(year), Number(month.value)); }
    year.oninput = month.onchange = limitDay;
    limitDay();
    for (const field of [title, description, year, month, day]) field.disabled = !editable;
    byId('timeline-event-heading').textContent = event ? (editable ? 'Edit event' : event.title) : 'Add event';
    eventForm.querySelector('button[type="submit"]').hidden = !editable;
    byId('timeline-delete-event').hidden = !event?.editable;
    eventForm.querySelector('[role="status"]').textContent = '';
    eventDialog.showModal();
  }

  eventForm.onsubmit = event => {
    event.preventDefault();
    const { title, description, year, month, day } = eventForm.elements;
    void change({ action: editingEvent ? 'update' : 'create', id: editingEvent?.id, title: title.value,
      description: description.value, year: integer(year), month: Number(month.value), day: integer(day) }, eventDialog);
  };
  byId('timeline-delete-event').onclick = () => {
    if (editingEvent && confirm('Delete this event?')) void change({ action: 'delete', id: editingEvent.id }, eventDialog);
  };
  byId('timeline-add-event').onclick = () => openEvent(null);
  timelineButton.onclick = () => { view = 'timeline'; render(); };
  calendarButton.onclick = () => { view = 'calendar'; render(); };

  function timePage(page) {
    for (const button of timeDialog.querySelectorAll('[data-time-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.timeTab === page));
    }
    for (const section of systemForm.querySelectorAll('[data-time-section]')) section.hidden = section.dataset.timeSection !== page;
    const custom = systemForm.elements.preset.value === 'custom';
    for (const field of systemForm.querySelectorAll('[data-custom-time]')) field.disabled = !custom;
    const overview = byId('time-overview-stats');
    const months = custom ? parseMonths() : system.months;
    const week = custom ? lines(systemForm.elements.weekdays.value) : system.weekdays;
    const entries = [
      ['Hours per day', custom ? systemForm.elements.hours.value : system.hoursPerDay],
      ['Days per week', week.length], ['Months per year', months.length],
      ['Minutes per hour', custom ? systemForm.elements.minutes.value : system.minutesPerHour],
      ['Days per year', custom ? months.reduce((sum, row) => sum + (row.days || 0), 0) : '365/366'],
    ];
    overview.replaceChildren(...entries.map(([label, value]) => {
      const card = document.createElement('div');
      const term = document.createElement('dt');
      const number = document.createElement('dd');
      term.textContent = label;
      number.textContent = value;
      card.append(term, number);
      return card;
    }));
  }

  const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
  function pairs(value, name) {
    return lines(value).map(line => {
      const separator = line.lastIndexOf('|');
      return { name: separator < 0 ? '' : line.slice(0, separator).trim(),
        [name]: separator < 0 ? NaN : Number(line.slice(separator + 1).trim()) };
    });
  }
  function parseMonths() { return pairs(systemForm.elements.months.value, 'days'); }

  for (const button of timeDialog.querySelectorAll('[data-time-tab]')) button.onclick = () => timePage(button.dataset.timeTab);
  function readCustom() {
    const fields = systemForm.elements;
    return { mode: 'custom', months: parseMonths(), weekdays: lines(fields.weekdays.value),
      hoursPerDay: integer(fields.hours), minutesPerHour: integer(fields.minutes), eras: pairs(fields.eras.value, 'start') };
  }

  function fillSystem(source) {
    const fields = systemForm.elements;
    fields.months.value = source.months.map(row => row.name + ' | ' + row.days).join('\n');
    fields.weekdays.value = source.weekdays.join('\n');
    fields.hours.value = source.hoursPerDay;
    fields.minutes.value = source.minutesPerHour;
    fields.eras.value = source.eras.map(row => row.name + ' | ' + row.start).join('\n');
  }
  systemForm.elements.preset.onchange = () => {
    if (systemForm.elements.preset.value === 'custom') fillSystem(customDraft);
    else {
      customDraft = readCustom();
      fillSystem(system);
    }
    timePage('overview');
  };
  byId('timeline-time-system').onclick = () => {
    if (!state?.canManage) return;
    const source = state.calendar;
    // The Gregorian preset stays available while editing a custom calendar.
    const defaultNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    system = { hoursPerDay: 24, minutesPerHour: 60, weekdays: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
      months: defaultNames.map((name, i) => ({ name, days: [31,28,31,30,31,30,31,31,30,31,30,31][i] })), eras: [] };
    customDraft = source.mode === 'custom' ? source : system;
    systemForm.elements.preset.value = source.mode;
    fillSystem(source);
    systemForm.querySelector('[role="status"]').textContent = '';
    timePage('overview');
    timeDialog.showModal();
  };
  systemForm.onsubmit = event => {
    event.preventDefault();
    const calendar = systemForm.elements.preset.value === 'gregorian' ? { mode: 'gregorian' } : readCustom();
    void change({ action: 'calendar', calendar }, timeDialog);
  };

  return {
    show(id) {
      root.hidden = false;
      if (id === conversation) return;
      conversation = id;
      state = shownMonth = null;
      view = 'timeline';
      status.textContent = '';
      content.replaceChildren();
      byId('timeline-add-event').hidden = byId('timeline-time-system').hidden = true;
      void refresh();
    },
    hide() {
      root.hidden = true;
      conversation = null;
      eventDialog.close();
      timeDialog.close();
    },
    refresh,
  };
}
