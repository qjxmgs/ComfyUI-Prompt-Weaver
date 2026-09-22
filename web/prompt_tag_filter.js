export const MIN_POST_COUNT_SETTING_ID = "PromptWeaver.Autocomplete.MinPostCount";
export const DEFAULT_MIN_POST_COUNT = 100;
export const MIN_POST_COUNT = 10;

export function parseMinPostCount(value) {
    if (!/^[0-9]+$/.test(String(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= MIN_POST_COUNT ? number : null;
}

// One coordinator is shared by both settings surfaces. Saves are serialized and
// every input/change invalidates old statistics, including non-abortable responses.
export class DanbooruFilterState {
    constructor({ value, save, status, changed = () => {}, delay = 300 }) {
        this.value = parseMinPostCount(value) ?? DEFAULT_MIN_POST_COUNT;
        this.draft = String(this.value);
        this.save = save;
        this.fetchStatus = status;
        this.changed = changed;
        this.delay = delay;
        this.sequence = 0;
        this.queue = Promise.resolve();
        this.pending = false;
        this.invalid = false;
        this.error = "";
        this.status = null;
        this.saving = false;
    }

    invalidate() {
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = new AbortController();
        return ++this.sequence;
    }

    input(raw) {
        const sequence = this.invalidate();
        this.draft = String(raw);
        const value = parseMinPostCount(raw);
        this.invalid = value === null;
        this.pending = !this.invalid;
        this.error = "";
        this.changed();
        if (this.invalid) return;
        this.timer = setTimeout(() => {
            this.queue = this.queue.catch(() => {}).then(async () => {
                if (sequence !== this.sequence) return;
                this.saving = true;
                try {
                    await this.save(value);
                    this.value = value;
                    if (sequence === this.sequence) await this.statistics(sequence, value);
                } catch (error) {
                    if (sequence === this.sequence) {
                        this.error = String(error?.message || error);
                        this.pending = false;
                        this.changed();
                    }
                } finally {
                    this.saving = false;
                }
            });
        }, this.delay);
    }

    async statistics(sequence, value) {
        try {
            const status = await this.fetchStatus(value, this.controller.signal);
            if (sequence !== this.sequence) return;
            this.status = status;
            this.error = "";
        } catch (error) {
            if (sequence !== this.sequence) return;
            this.error = String(error?.message || error);
        }
        if (sequence === this.sequence) {
            this.pending = false;
            this.changed();
        }
    }

    refresh(value = this.value) {
        if (this.saving) return;
        const sequence = this.invalidate();
        this.value = parseMinPostCount(value) ?? DEFAULT_MIN_POST_COUNT;
        this.draft = String(this.value);
        this.invalid = false;
        this.pending = true;
        this.changed();
        return this.statistics(sequence, this.value);
    }

    dispose() { this.invalidate(); }
}
