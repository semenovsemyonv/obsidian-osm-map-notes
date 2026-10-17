import { App, FuzzyMatch, FuzzySuggestModal, Modal, Setting, TFile } from "obsidian";
import { MARKER_COLORS } from "./types";

type NoteChoice = { kind: "file"; file: TFile } | { kind: "new" } | { kind: "none" };

/** Выбор заметки для метки: существующая, новая или без заметки */
export class NotePickerModal extends FuzzySuggestModal<NoteChoice> {
	constructor(app: App, private onPick: (choice: NoteChoice, query: string) => void) {
		super(app);
		this.setPlaceholder("Выберите заметку для метки или введите имя новой…");
		this.setInstructions([
			{ command: "↑↓", purpose: "навигация" },
			{ command: "↵", purpose: "выбрать" },
			{ command: "esc", purpose: "отмена" },
		]);
	}

	getItems(): NoteChoice[] {
		const files = this.app.vault.getMarkdownFiles()
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.map((file) => ({ kind: "file", file }) as NoteChoice);
		return [{ kind: "new" }, { kind: "none" }, ...files];
	}

	getItemText(item: NoteChoice): string {
		if (item.kind === "file") return item.file.path;
		// служебные пункты всегда должны находиться поиском
		return this.inputEl.value;
	}

	renderSuggestion(match: FuzzyMatch<NoteChoice>, el: HTMLElement) {
		const item = match.item;
		const q = this.inputEl.value.trim();
		if (item.kind === "new") {
			el.createDiv({ text: q ? `＋ Создать заметку «${q}»` : "＋ Создать новую заметку", cls: "gis-suggest-special" });
		} else if (item.kind === "none") {
			el.createDiv({ text: q ? `📍 Метка «${q}» без заметки` : "📍 Метка без заметки", cls: "gis-suggest-special" });
		} else {
			super.renderSuggestion(match, el);
		}
	}

	onChooseItem(item: NoteChoice): void {
		this.onPick(item, this.inputEl.value.trim());
	}
}

/** Простой запрос строки */
export class PromptModal extends Modal {
	private value: string;

	constructor(app: App, private title: string, initial: string, private onSubmit: (value: string) => void) {
		super(app);
		this.value = initial;
	}

	onOpen() {
		this.titleEl.setText(this.title);
		const submit = () => {
			const v = this.value.trim();
			if (!v) return;
			this.close();
			this.onSubmit(v);
		};
		new Setting(this.contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.style.width = "100%";
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); submit(); }
			});
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		}).settingEl.addClass("gis-prompt-row");
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private text: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Удалить").setWarning().onClick(() => { this.close(); this.onConfirm(); }));
	}

	onClose() {
		this.contentEl.empty();
	}
}

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	const n = parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
	return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Выбор цвета метки: палитра, системная пипетка, HEX и R/G/B */
export class ColorModal extends Modal {
	private rgb: [number, number, number];

	constructor(app: App, initial: string, private onPick: (color: string) => void) {
		super(app);
		this.rgb = hexToRgb(initial) ?? [229, 72, 77];
	}

	onOpen() {
		this.titleEl.setText("Цвет метки");
		this.modalEl.addClass("gis-color-modal");
		const { contentEl } = this;

		const top = contentEl.createDiv("gis-color-top");
		const preview = top.createDiv("gis-color-preview");
		preview.createDiv("gis-pin-head").createDiv("gis-pin-dot");
		const palette = top.createDiv("gis-color-palette");

		const picker = contentEl.createDiv("gis-color-row");
		picker.createSpan({ text: "Любой цвет", cls: "gis-color-label" });
		const native = picker.createEl("input", { type: "color", cls: "gis-color-native" });
		const hexInput = picker.createEl("input", { type: "text", cls: "gis-color-hex", attr: { maxlength: "7", spellcheck: "false" } });

		const rgbRow = contentEl.createDiv("gis-color-row gis-color-rgb");
		const channels = (["R", "G", "B"] as const).map((label, i) => {
			const wrap = rgbRow.createDiv("gis-color-channel");
			wrap.createSpan({ text: label, cls: "gis-color-label" });
			const range = wrap.createEl("input", { type: "range", attr: { min: "0", max: "255", step: "1" } });
			const num = wrap.createEl("input", { type: "number", attr: { min: "0", max: "255" } });
			const set = (v: number) => {
				this.rgb[i] = Math.max(0, Math.min(255, Math.round(v || 0)));
				refresh(range === document.activeElement ? range : num === document.activeElement ? num : null);
			};
			range.addEventListener("input", () => set(+range.value));
			num.addEventListener("input", () => set(+num.value));
			return { range, num };
		});

		const swatches = MARKER_COLORS.map((c) => {
			const sw = palette.createDiv({ cls: "gis-color-swatch", attr: { "aria-label": c } });
			sw.style.backgroundColor = c;
			sw.onclick = () => { this.rgb = hexToRgb(c)!; refresh(null); };
			return { sw, c };
		});

		const refresh = (skip: HTMLElement | null) => {
			const hex = rgbToHex(this.rgb);
			preview.style.setProperty("--pin-color", hex);
			if (skip !== native) native.value = hex;
			if (skip !== hexInput) hexInput.value = hex;
			channels.forEach(({ range, num }, i) => {
				if (skip !== range) range.value = String(this.rgb[i]);
				if (skip !== num) num.value = String(this.rgb[i]);
				range.style.setProperty("--track", `linear-gradient(to right, ${rgbToHex(this.rgb.map((v, j) => (j === i ? 0 : v)) as [number, number, number])}, ${rgbToHex(this.rgb.map((v, j) => (j === i ? 255 : v)) as [number, number, number])})`);
			});
			swatches.forEach(({ sw, c }) => sw.toggleClass("is-active", c.toLowerCase() === hex));
		};

		native.addEventListener("input", () => { this.rgb = hexToRgb(native.value)!; refresh(native); });
		hexInput.addEventListener("input", () => {
			const rgb = hexToRgb(hexInput.value);
			hexInput.toggleClass("is-invalid", !rgb);
			if (rgb) { this.rgb = rgb; refresh(hexInput); }
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Применить").setCta().onClick(() => {
				this.close();
				this.onPick(rgbToHex(this.rgb));
			}));

		refresh(null);
	}

	onClose() {
		this.contentEl.empty();
	}
}
