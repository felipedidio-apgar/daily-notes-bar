import { ItemView, Notice, Plugin, WorkspaceLeaf, setIcon } from 'obsidian';
import {
	createDailyNote,
	getDailyNote,
	getAllDailyNotes,
	getDailyNoteSettings,
	appHasDailyNotesPluginLoaded
} from 'obsidian-daily-notes-interface';
import moment from 'moment';

const VIEW_TYPE_DATE_PANEL = 'daily-note-date-panel';
const ROW_HEIGHT = 28; // Fixed height for each date row
const BUFFER_ROWS = 5; // Extra rows to render above/below viewport
const INITIAL_RANGE_DAYS = 365; // Initial range: 1 year in each direction

class DatePanelView extends ItemView {
	private container: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private scrollContainer: HTMLElement | null = null;
	private spacer: HTMLElement | null = null;
	private todayBtn: HTMLElement | null = null;
	private anchorDate: moment.Moment | null = null; // The "zero" reference point (today at init)
	private minDayOffset = 0; // Days before anchor (negative direction)
	private maxDayOffset = 0; // Days after anchor (positive direction)
	private renderedElements: Map<number, HTMLElement> = new Map(); // dayOffset -> element
	private dateFormat = 'YYYY-MM-DD';
	private dailyNotes: Record<string, any> = {};
	private scrollRAF: number | null = null;
	private lastKnownToday: string | null = null; // Track the date to detect day changes

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DATE_PANEL;
	}

	getDisplayText(): string {
		return 'Daily Notes';
	}

	getIcon(): string {
		return 'calendar';
	}

	async onOpen() {
		this.container = this.containerEl.children[1] as HTMLElement;
		this.container.empty();
		this.container.addClass('date-panel-container');

		const { format } = getDailyNoteSettings();
		this.dateFormat = format || 'YYYY-MM-DD';
		this.dailyNotes = getAllDailyNotes();
		this.lastKnownToday = moment().format('YYYY-MM-DD');

		this.initList();

		// Listen for window focus to detect day changes
		window.addEventListener('focus', this.handleWindowFocus);
	}

	async onClose() {
		if (this.scrollContainer) {
			this.scrollContainer.removeEventListener('scroll', this.handleScroll);
		}
		if (this.scrollRAF) {
			cancelAnimationFrame(this.scrollRAF);
		}
		window.removeEventListener('focus', this.handleWindowFocus);
		this.renderedElements.clear();
	}

	private handleWindowFocus = () => {
		const currentToday = moment().format('YYYY-MM-DD');
		if (this.lastKnownToday && currentToday !== this.lastKnownToday) {
			this.lastKnownToday = currentToday;
			this.refreshForNewDay();
		}
	};

	private getTodayOffset(): number {
		if (!this.anchorDate) return 0;
		const today = moment().startOf('day');
		return today.diff(this.anchorDate, 'days');
	}

	private refreshForNewDay() {
		if (!this.anchorDate || !this.listEl) return;

		// Calculate the new "today" offset relative to anchor
		const newTodayOffset = this.getTodayOffset();

		// Update all rendered elements to reflect the new "today"
		for (const [offset, element] of this.renderedElements) {
			const wasToday = element.classList.contains('is-today');
			const isNowToday = offset === newTodayOffset;

			if (wasToday && !isNowToday) {
				element.classList.remove('is-today');
				element.removeAttribute('data-today');
			} else if (!wasToday && isNowToday) {
				element.classList.add('is-today');
				element.setAttribute('data-today', 'true');
			}
		}

		// Refresh daily notes cache in case new notes were created
		this.dailyNotes = getAllDailyNotes();

		// Update today button visibility
		this.updateTodayButtonVisibility();
	}

	private initList() {
		if (!this.container) return;

		// Create "Go to Today" button
		this.todayBtn = this.container.createEl('button', {
			cls: 'date-panel-today-btn',
			attr: { 'aria-label': 'Go to today' }
		});
		setIcon(this.todayBtn, 'calendar-days');
		this.todayBtn.createSpan({ text: 'Today' });
		this.todayBtn.addEventListener('click', () => this.scrollToToday());

		// Create scrollable list container
		this.scrollContainer = this.container.createEl('div', { cls: 'date-panel-scroll' });
		this.listEl = this.scrollContainer.createEl('div', { cls: 'date-panel-list' });

		// Create spacer element that defines the scrollable height
		this.spacer = this.listEl.createEl('div', { cls: 'date-panel-spacer' });

		// Set anchor to today
		this.anchorDate = moment().startOf('day');
		this.minDayOffset = -INITIAL_RANGE_DAYS;
		this.maxDayOffset = INITIAL_RANGE_DAYS;

		// Set initial spacer height
		this.updateSpacerHeight();

		// Add scroll listener
		this.scrollContainer.addEventListener('scroll', this.handleScroll);

		// Wait for container to have dimensions before scrolling
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.contentRect.height > 0) {
					resizeObserver.disconnect();
					this.scrollToToday(false);
					this.renderVisibleDates();
					this.updateTodayButtonVisibility();
				}
			}
		});
		resizeObserver.observe(this.scrollContainer);
	}

	private updateSpacerHeight() {
		if (!this.spacer) return;
		const totalDays = this.maxDayOffset - this.minDayOffset + 1;
		this.spacer.style.height = `${totalDays * ROW_HEIGHT}px`;
	}

	private dayOffsetToScrollTop(dayOffset: number): number {
		// Convert a day offset to its scroll position
		const index = dayOffset - this.minDayOffset;
		return index * ROW_HEIGHT;
	}

	private scrollTopToDayOffset(scrollTop: number): number {
		// Convert scroll position to day offset
		const index = Math.floor(scrollTop / ROW_HEIGHT);
		return index + this.minDayOffset;
	}

	private scrollToToday(smooth = true) {
		if (!this.scrollContainer) return;

		// Get today's offset relative to anchor
		const todayOffset = this.getTodayOffset();
		const todayScrollTop = this.dayOffsetToScrollTop(todayOffset);
		const containerHeight = this.scrollContainer.clientHeight;
		const targetScroll = todayScrollTop - (containerHeight / 2) + (ROW_HEIGHT / 2);

		if (smooth) {
			this.scrollContainer.scrollTo({ top: targetScroll, behavior: 'smooth' });
		} else {
			this.scrollContainer.scrollTop = targetScroll;
		}
	}

	private renderVisibleDates() {
		if (!this.scrollContainer || !this.listEl || !this.anchorDate) return;

		const { scrollTop, clientHeight } = this.scrollContainer;

		// Calculate visible range with buffer
		const firstVisibleOffset = this.scrollTopToDayOffset(scrollTop) - BUFFER_ROWS;
		const lastVisibleOffset = this.scrollTopToDayOffset(scrollTop + clientHeight) + BUFFER_ROWS;

		// Clamp to our current range
		const startOffset = Math.max(firstVisibleOffset, this.minDayOffset);
		const endOffset = Math.min(lastVisibleOffset, this.maxDayOffset);

		// Track which offsets should be rendered
		const neededOffsets = new Set<number>();
		for (let offset = startOffset; offset <= endOffset; offset++) {
			neededOffsets.add(offset);
		}

		// Remove elements that are no longer visible
		for (const [offset, element] of this.renderedElements) {
			if (!neededOffsets.has(offset)) {
				element.remove();
				this.renderedElements.delete(offset);
			}
		}

		// Add elements that need to be rendered
		for (const offset of neededOffsets) {
			if (!this.renderedElements.has(offset)) {
				const date = moment(this.anchorDate).add(offset, 'days');
				const element = this.createDayElement(date, offset);
				this.listEl.appendChild(element);
				this.renderedElements.set(offset, element);
			}
		}

		// Expand range if we're near the edges
		this.expandRangeIfNeeded(startOffset, endOffset);
	}

	private expandRangeIfNeeded(visibleStart: number, visibleEnd: number) {
		// Expand backwards if near the start
		if (visibleStart <= this.minDayOffset + BUFFER_ROWS) {
			const oldMin = this.minDayOffset;
			this.minDayOffset -= INITIAL_RANGE_DAYS;
			const addedDays = oldMin - this.minDayOffset;

			// Update spacer height
			this.updateSpacerHeight();

			// Adjust scroll position to compensate for content added above
			if (this.scrollContainer) {
				this.scrollContainer.scrollTop += addedDays * ROW_HEIGHT;
			}

			// Reposition all existing elements since minDayOffset changed
			this.repositionAllElements();
		}

		// Expand forwards if near the end
		if (visibleEnd >= this.maxDayOffset - BUFFER_ROWS) {
			this.maxDayOffset += INITIAL_RANGE_DAYS;
			this.updateSpacerHeight();
		}
	}

	private repositionAllElements() {
		for (const [offset, element] of this.renderedElements) {
			element.style.top = `${this.dayOffsetToScrollTop(offset)}px`;
		}
	}

	private updateTodayButtonVisibility() {
		if (!this.todayBtn || !this.scrollContainer) return;

		const { scrollTop, clientHeight } = this.scrollContainer;

		// Calculate where today is in the scroll
		const todayOffset = this.getTodayOffset();
		const todayScrollTop = this.dayOffsetToScrollTop(todayOffset);
		const todayScrollBottom = todayScrollTop + ROW_HEIGHT;

		// Check if today is visible in the viewport
		const isVisible = todayScrollTop >= scrollTop && todayScrollBottom <= scrollTop + clientHeight;

		if (isVisible) {
			this.todayBtn.classList.add('hidden');
		} else {
			this.todayBtn.classList.remove('hidden');

			// Position based on where today is relative to viewport
			if (todayScrollTop < scrollTop) {
				// Today is above viewport (we're looking at the future)
				this.todayBtn.classList.add('position-top');
				this.todayBtn.classList.remove('position-bottom');
			} else {
				// Today is below viewport (we're looking at the past)
				this.todayBtn.classList.add('position-bottom');
				this.todayBtn.classList.remove('position-top');
			}
		}
	}

	private handleScroll = () => {
		if (this.scrollRAF) {
			cancelAnimationFrame(this.scrollRAF);
		}

		this.scrollRAF = requestAnimationFrame(() => {
			this.renderVisibleDates();
			this.updateTodayButtonVisibility();
		});
	};

	private createDayElement(date: moment.Moment, dayOffset: number): HTMLElement {
		const note = getDailyNote(date, this.dailyNotes);
		const exists = note !== null;
		const todayOffset = this.getTodayOffset();
		const isToday = dayOffset === todayOffset;

		const dayEl = document.createElement('div');
		dayEl.className = `date-panel-day ${exists ? 'exists' : 'not-exists'} ${isToday ? 'is-today' : ''}`;
		dayEl.textContent = date.format(this.dateFormat);
		dayEl.setAttribute('data-date', date.format('YYYY-MM-DD'));
		dayEl.setAttribute('data-offset', String(dayOffset));

		// Position absolutely
		dayEl.style.position = 'absolute';
		dayEl.style.top = `${this.dayOffsetToScrollTop(dayOffset)}px`;
		dayEl.style.left = '0';
		dayEl.style.right = '0';
		dayEl.style.height = `${ROW_HEIGHT}px`;

		if (isToday) {
			dayEl.setAttribute('data-today', 'true');
		}

		dayEl.addEventListener('click', () => {
			this.openDailyNote(date);
		});

		return dayEl;
	}

	private async openDailyNote(date: moment.Moment) {
		if (!appHasDailyNotesPluginLoaded()) {
			new Notice('Daily Notes core plugin is not enabled.');
			return;
		}

		let note = getDailyNote(date, this.dailyNotes);

		if (!note) {
			note = await createDailyNote(date);
			// Refresh daily notes cache and update the element
			this.dailyNotes = getAllDailyNotes();
			this.updateDayElement(date);
		}

		await this.app.workspace.getLeaf().openFile(note as any);
	}

	private updateDayElement(date: moment.Moment) {
		if (!this.listEl || !this.anchorDate) return;

		const dateStr = date.format('YYYY-MM-DD');
		const el = this.listEl.querySelector(`[data-date="${dateStr}"]`);
		if (el) {
			el.classList.remove('not-exists');
			el.classList.add('exists');
		}
	}
}

export default class DailyNoteButtonPlugin extends Plugin {
	async onload() {
		// Register the date panel view
		this.registerView(VIEW_TYPE_DATE_PANEL, (leaf) => new DatePanelView(leaf));

		// Command to open today's daily note
		this.addCommand({
			id: 'open-todays-daily-note',
			name: "Open today's daily note",
			callback: () => {
				this.openTodaysDailyNote();
			}
		});

		// Command to show the date panel
		this.addCommand({
			id: 'show-date-panel',
			name: 'Show date panel',
			callback: () => {
				this.activateDatePanel();
			}
		});

		// Automatically open the date panel on startup (without stealing focus)
		this.app.workspace.onLayoutReady(() => {
			this.initDatePanel();
		});
	}

	onunload() {
		// Clean up the view when plugin is disabled
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DATE_PANEL);
	}

	// Initialize panel without stealing focus (used on startup)
	async initDatePanel() {
		const { workspace } = this.app;

		// Only create if it doesn't exist
		if (workspace.getLeavesOfType(VIEW_TYPE_DATE_PANEL).length === 0) {
			const leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({
				type: VIEW_TYPE_DATE_PANEL,
				active: false,
			});
		}
	}

	// Activate and focus the panel (used by command)
	async activateDatePanel() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DATE_PANEL)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({
				type: VIEW_TYPE_DATE_PANEL,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);
	}

	async openTodaysDailyNote() {
		if (!appHasDailyNotesPluginLoaded()) {
			new Notice('Daily Notes core plugin is not enabled.');
			return;
		}

		const today = moment();
		const dailyNotes = getAllDailyNotes();
		let note = getDailyNote(today, dailyNotes);

		if (!note) {
			note = await createDailyNote(today);
		}

		await this.app.workspace.getLeaf().openFile(note as any);
	}
}
