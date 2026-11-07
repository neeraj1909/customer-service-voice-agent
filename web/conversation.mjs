// An explicit command grammar, not a natural-language model.
export function parseCommand(input) {
  const text = input.trim();
  const patterns = [
    [/^(order|ऑर्डर|mera order) ([A-Za-z0-9-]{1,80})$/iu, 'order'],
    [/^(slots|समय|slots dikhao) ([A-Za-z0-9-]{1,80})$/iu, 'slots'],
    [/^(change|बदलें|badlo) ([A-Za-z0-9-]{1,80}) ([A-Za-z0-9-]{1,80})$/iu, 'change'],
    [/^(human|human help|मानव|insaan)$/iu, 'human'],
    [/^(yes|हाँ|haan)$/iu, 'yes'],
    [/^(no|नहीं|nahin)$/iu, 'no'],
    [/^(retry|फिर प्रयास|dobara)$/iu, 'retry'],
  ];
  for (const [pattern, type] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const word = match[1].toLowerCase();
    const language = /[\u0900-\u097f]/u.test(word) ? 'hi' :
      ['mera order', 'slots dikhao', 'badlo', 'insaan', 'haan', 'nahin', 'dobara'].includes(word) ? 'hinglish' : 'en';
    if (type === 'change') return {type, appointment:match[2], slot:match[3], language};
    if (type === 'order' || type === 'slots') return {type, id:match[2], language};
    return {type, language};
  }
  return {type:'unknown'};
}

const text = {
  en: {clarify:'Use an exact listed command. Nothing was changed.', offer:'Would you like a local handoff request? Reply yes or no.', yes:'yes or no', recorded:'Request recorded locally; no human was contacted.', rejected:'Cancelled; no change was made.', retry:'Outcome unknown. Type retry to repeat the same request.', noPending:'There is no pending confirmation or offer.', noOp:'This appointment already uses that slot; no change was made.'},
  hi: {clarify:'दिए गए पूरे कमांड का उपयोग करें। कोई बदलाव नहीं हुआ।', offer:'स्थानीय सहायता अनुरोध दर्ज करें? हाँ या नहीं लिखें।', yes:'हाँ या नहीं', recorded:'अनुरोध स्थानीय रूप से दर्ज हुआ; किसी व्यक्ति से संपर्क नहीं हुआ।', rejected:'रद्द किया गया; कोई बदलाव नहीं हुआ।', retry:'परिणाम अज्ञात है। वही अनुरोध दोहराने के लिए फिर प्रयास लिखें।', noPending:'कोई पुष्टि या प्रस्ताव लंबित नहीं है।', noOp:'अपॉइंटमेंट पहले से इस स्लॉट में है; बदलाव नहीं हुआ।'},
  hinglish: {clarify:'Poora listed command likhein. Koi change nahi hua.', offer:'Local handoff request record karein? haan ya nahin likhein.', yes:'haan ya nahin', recorded:'Request locally record hui; kisi human se contact nahi hua.', rejected:'Cancel hua; koi change nahi hua.', retry:'Result unknown hai. Wahi request dohrane ke liye dobara likhein.', noPending:'Koi confirmation ya offer pending nahi hai.', noOp:'Appointment pehle se is slot par hai; koi change nahi hua.'},
};

export class Conversation {
  constructor({request, say, key = () => crypto.randomUUID()}) {
    this.request = request; this.say = say; this.key = key;
    this.language = 'en'; this.pending = null; this.retry = null; this.unknowns = 0;
  }
  reset() { this.pending = null; this.retry = null; this.unknowns = 0; this.language = 'en'; }
  message(key) { return text[this.language][key]; }
  status(value) { return ({hi:{shipped:'भेज दिया गया', processing:'प्रक्रिया में'}, hinglish:{shipped:'bhej diya gaya', processing:'process mein'}}[this.language] || {})[value] || value; }
  async execute(path, body, onSuccess, onError) {
    try {
      const response = await this.request(path, body);
      this.retry = null;
      onSuccess(response);
    } catch (error) {
      if (error.blocked) {
        this.say(error.message);
      } else if (error.uncertain) {
        this.retry = {path, body, onSuccess, onError};
        this.say(`${this.message('retry')} ${error.message}`);
      } else {
        this.retry = null;
        onError(error);
      }
    }
  }
  offer(issue) {
    this.pending = {type:'offer', issue};
    this.say(this.message('offer'));
  }
  async handoff(issue) {
    const body = {issue, summary:issue, language:this.language, idempotency_key:this.key()};
    await this.execute('/api/handoff', body, () => { this.pending = null; this.say(this.message('recorded')); }, () => { this.pending = null; this.say('Local handoff recording failed.'); });
  }
  async send(input) {
    const cmd = parseCommand(input);
    if (this.retry) {
      if (cmd.type !== 'retry') { this.say(this.message('retry')); return; }
      const r = this.retry; await this.execute(r.path, r.body, r.onSuccess, r.onError); return;
    }
    if (cmd.type !== 'unknown') this.language = cmd.language;
    if (cmd.type === 'unknown') {
      this.say(this.message('clarify'));
      if (++this.unknowns >= 2 && !this.pending) this.offer('Unresolved controlled-command request');
      return;
    }
    this.unknowns = 0;
    if (cmd.type === 'yes' || cmd.type === 'no') {
      if (!this.pending) { this.say(this.message('noPending')); return; }
      if (this.pending.type === 'offer') {
        if (cmd.type === 'yes') await this.handoff(this.pending.issue);
        else { this.pending = null; this.say(this.message('rejected')); }
        return;
      }
      const p = this.pending;
      if (cmd.type === 'yes') {
        const body = {confirmation_id:p.confirmation_id, idempotency_key:p.key};
        await this.execute('/api/appointments/confirm', body, r => { this.pending = null; this.say(`${r.appointment_id}: ${r.slot_id}`); }, () => { this.pending = null; this.say(this.message('clarify')); this.offer('Appointment change could not be completed'); });
      } else {
        await this.execute('/api/appointments/reject', {confirmation_id:p.confirmation_id}, () => { this.pending = null; this.say(this.message('rejected')); }, () => { this.pending = null; this.say(this.message('clarify')); });
      }
      return;
    }
    if (this.pending) { this.say(`Reply ${this.message('yes')} before another command.`); return; }
    if (cmd.type === 'human') { await this.handoff('Customer requested human assistance'); return; }
    if (cmd.type === 'retry') { this.say(this.message('noPending')); return; }
    const fail = () => { this.say(this.message('clarify')); this.offer('Customer service request could not be completed'); };
    if (cmd.type === 'order') await this.execute('/api/order', {order_id:cmd.id}, r => this.say(`${r.id}: ${this.status(r.status)}`), fail);
    if (cmd.type === 'slots') await this.execute('/api/appointments/slots', {appointment_id:cmd.id}, r => this.say(r.slots.length ? r.slots.map(s => `${s.id}: ${s.time_utc}`).join('\n') : 'No available slots.'), fail);
    if (cmd.type === 'change') await this.execute('/api/appointments/propose', {appointment_id:cmd.appointment, slot_id:cmd.slot}, r => {
      if (r.no_op) { this.say(this.message('noOp')); return; }
      this.pending = {type:'change', confirmation_id:r.confirmation_id, key:this.key()};
      this.say(`${r.appointment_id}: ${r.original_slot} → ${r.slot_id}, ${r.time_utc}. ${this.message('yes')}?`);
    }, fail);
  }
}

// Guard every interface against discarding an uncertain write or its replay key.
export function createRequest({getSession, fetchImpl = fetch}) {
  let uncertain = null, inFlight = false;
  return async (path, body) => {
    const session = getSession();
    const payload = JSON.stringify(body);
    const write = path === '/api/appointments/confirm' || path === '/api/handoff';
    if (inFlight || (uncertain && (uncertain.path !== path || uncertain.payload !== payload || uncertain.session !== session))) {
      const error = new Error('Resolve the previous uncertain write using the original control first.');
      error.blocked = true; throw error;
    }
    const resolving = Boolean(uncertain);
    inFlight = true;
    try {
      const response = await fetchImpl(path, {method:'POST', headers:{'Content-Type':'application/json', 'X-Session':session}, body:payload});
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.message || data.error);
        if (response.status < 500 && !resolving) error.definitive = true;
        else if (resolving) error.message += ' Previous write outcome remains unknown; inspect local state before restarting the session.';
        throw error;
      }
      if (write) uncertain = null;
      return data;
    } catch (error) {
      if (write && !error.definitive) {
        uncertain = {path, payload, session};
        error.uncertain = true;
      } else if (write && error.definitive) uncertain = null;
      throw error;
    } finally {
      inFlight = false;
    }
  };
}
