import { App, PluginSettingTab, Setting } from "obsidian";
import type MapNotesPlugin from "./main";
import { COLOR_SCHEMES, ColorScheme, LABEL_LANGS, VECTOR_THEMES } from "./vectorStyle";
import { MapView, VIEW_TYPE_MAP } from "./mapView";
import { OfflineModal } from "./offlineModal";
import { DEFAULT_SETTINGS } from "./types";

export class MapSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MapNotesPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		const changed = () => {
			this.plugin.save(false);
			this.plugin.events.trigger("tiles-changed");
		};

		new Setting(containerEl)
			.setName("Подложка карты")
			.setDesc("Все варианты — на данных OpenStreetMap, ключ API не нужен.")
			.addDropdown((d) => d
				.addOption("osm", "OpenStreetMap (растровая)")
				.addOption("vector", "OpenFreeMap (векторная: темы и язык подписей)")
				.addOption("custom", "Свой URL тайлов…")
				.setValue(s.tileProvider in { osm: 1, vector: 1, custom: 1 } ? s.tileProvider : "osm")
				.onChange((v) => {
					s.tileProvider = v;
					changed();
					this.display();
				}));

		if (s.tileProvider === "vector") {
			new Setting(containerEl)
				.setName("Тема карты")
				.addDropdown((d) => {
					for (const [id, name] of Object.entries(VECTOR_THEMES)) d.addOption(id, name);
					d.setValue(s.vectorTheme).onChange((v) => { s.vectorTheme = v; changed(); });
				});
			new Setting(containerEl)
				.setName("Цветовая схема")
				.setDesc("Действует на все темы.")
				.addDropdown((d) => {
					for (const [id, name] of Object.entries(COLOR_SCHEMES)) d.addOption(id, name);
					d.setValue(s.colorScheme).onChange((v) => {
						s.colorScheme = v as ColorScheme;
						changed();
					});
				});
			new Setting(containerEl)
				.setName("3D-здания")
				.setDesc("Объёмные дома при приближении, для всех тем. Наклон и поворот — правой кнопкой мыши или Ctrl+перетаскивание.")
				.addToggle((t) => t.setValue(s.buildings3d).onChange((v) => { s.buildings3d = v; changed(); }));
			new Setting(containerEl)
				.setName("Язык подписей")
				.setDesc("Если у объекта нет перевода, показывается английское, а затем местное название.")
				.addDropdown((d) => {
					for (const [id, name] of Object.entries(LABEL_LANGS)) d.addOption(id, name);
					d.setValue(s.labelLang).onChange((v) => { s.labelLang = v; changed(); });
				});
			containerEl.createDiv({
				cls: "setting-item-description gis-setting-note",
				text: "Векторная карта работает только онлайн. В офлайн-режиме используются скачанные области OpenStreetMap.",
			});
		}

		if (s.tileProvider === "custom") {
			new Setting(containerEl)
				.setName("URL тайлов")
				.setDesc("Шаблон XYZ, например https://tile.openstreetmap.org/{z}/{x}/{y}.png")
				.addText((t) => t
					.setPlaceholder("https://…/{z}/{x}/{y}.png")
					.setValue(s.customTileUrl)
					.onChange((v) => {
						s.customTileUrl = v.trim();
						if (/\{z\}.*\{x\}.*\{y\}/.test(s.customTileUrl)) changed();
					}));
		}

		new Setting(containerEl)
			.setName("Режим карты")
			.setDesc("Онлайн — карта из сети, всегда актуальная. Офлайн — только скачанные области.")
			.addDropdown((d) => d
				.addOption("online", "Онлайн")
				.addOption("offline", "Офлайн")
				.setValue(s.mapMode)
				.onChange((v) => this.plugin.setMapMode(v as "online" | "offline")))
			.addButton((b) => b.setButtonText("Офлайн-карты…").onClick(() => {
				const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)[0]?.view;
				new OfflineModal(this.app, this.plugin, view instanceof MapView ? view : null).open();
			}));

		new Setting(containerEl)
			.setName("Отображать название метки всегда")
			.setDesc("Иначе название показывается только при наведении на метку.")
			.addToggle((tg) => tg
				.setValue(s.alwaysShowLabels)
				.onChange((v) => { s.alwaysShowLabels = v; this.plugin.save(); }));

		new Setting(containerEl)
			.setName("Скорость перелёта к метке")
			.setDesc("Ограничивает скорость камеры (экранов в секунду): чем дальше метка, тем дольше перелёт. Близкие — не быстрее 0,5 с, самые дальние — не дольше 6 с. По умолчанию 3.")
			.addSlider((sl) => sl
				.setLimits(1, 8, 0.5)
				.setValue(s.flySpeed)
				.setDynamicTooltip()
				.onChange((v) => { s.flySpeed = v; this.plugin.save(false); }))
			.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("По умолчанию").onClick(() => {
				s.flySpeed = DEFAULT_SETTINGS.flySpeed;
				this.plugin.save(false);
				this.display();
			}));

		new Setting(containerEl)
			.setName("Открывать карточку после перелёта")
			.addToggle((tg) => tg
				.setValue(s.openCardOnFly)
				.onChange((v) => { s.openCardOnFly = v; this.plugin.save(false); }));
	}
}
