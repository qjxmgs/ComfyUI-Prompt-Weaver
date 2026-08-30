export const PROMPT_EDITOR_HISTORY_LIMIT = 100;

function cloneSnapshot(snapshot) {
    if (typeof structuredClone === "function") return structuredClone(snapshot);
    return JSON.parse(JSON.stringify(snapshot));
}

function snapshotKey(snapshot) {
    return JSON.stringify(snapshot);
}

export class PromptEditorHistory {
    constructor(limit = PROMPT_EDITOR_HISTORY_LIMIT) {
        this.limit = Number.isInteger(limit) && limit > 0
            ? limit
            : PROMPT_EDITOR_HISTORY_LIMIT;
        this.undoStack = [];
        this.redoStack = [];
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get undoCount() {
        return this.undoStack.length;
    }

    get redoCount() {
        return this.redoStack.length;
    }

    record(previousSnapshot, nextSnapshot) {
        const previousKey = snapshotKey(previousSnapshot);
        if (previousKey === snapshotKey(nextSnapshot)) return false;
        const lastSnapshot = this.undoStack[this.undoStack.length - 1];
        if (!lastSnapshot || snapshotKey(lastSnapshot) !== previousKey) {
            this.undoStack.push(cloneSnapshot(previousSnapshot));
            if (this.undoStack.length > this.limit) this.undoStack.shift();
        }
        this.redoStack.length = 0;
        return true;
    }

    undo(currentSnapshot) {
        if (!this.canUndo) return null;
        const snapshot = this.undoStack.pop();
        this.redoStack.push(cloneSnapshot(currentSnapshot));
        if (this.redoStack.length > this.limit) this.redoStack.shift();
        return cloneSnapshot(snapshot);
    }

    redo(currentSnapshot) {
        if (!this.canRedo) return null;
        const snapshot = this.redoStack.pop();
        this.undoStack.push(cloneSnapshot(currentSnapshot));
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        return cloneSnapshot(snapshot);
    }

    clear() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
    }
}
