// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { isEditableTarget, isPlaybackToggleShortcut } from '../../utils/keyboard';

const createKeyEvent = (init: KeyboardEventInit = {}): KeyboardEvent =>
    new KeyboardEvent('keydown', {
        code: 'Space',
        key: ' ',
        bubbles: true,
        cancelable: true,
        ...init,
    });

describe('isEditableTarget', () => {
    it('识别输入框、文本域、下拉框与可编辑区域', () => {
        expect(isEditableTarget(document.createElement('input'))).toBe(true);
        expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
        expect(isEditableTarget(document.createElement('select'))).toBe(true);

        const editable = document.createElement('div');
        editable.contentEditable = 'true';
        expect(isEditableTarget(editable)).toBe(true);
    });

    it('普通元素与空目标不算输入目标', () => {
        expect(isEditableTarget(document.createElement('div'))).toBe(false);
        expect(isEditableTarget(document.createElement('button'))).toBe(false);
        expect(isEditableTarget(null)).toBe(false);
        expect(isEditableTarget(document)).toBe(false);
    });
});

describe('isPlaybackToggleShortcut', () => {
    const createEventOn = (target: EventTarget): KeyboardEvent => {
        const event = createKeyEvent();
        target.dispatchEvent(event);
        return event;
    };

    it('空格键触发播放/暂停', () => {
        expect(isPlaybackToggleShortcut(createEventOn(document.createElement('div')))).toBe(true);
        // 部分键盘布局只有 key 为空格，没有对应的 code
        expect(isPlaybackToggleShortcut(createKeyEvent({ code: '' }))).toBe(true);
    });

    it('其它按键不触发', () => {
        expect(isPlaybackToggleShortcut(createKeyEvent({ code: 'Enter', key: 'Enter' }))).toBe(
            false,
        );
        expect(
            isPlaybackToggleShortcut(createKeyEvent({ code: 'ArrowDown', key: 'ArrowDown' })),
        ).toBe(false);
    });

    it('长按重复、输入法组合和修饰键不触发', () => {
        expect(isPlaybackToggleShortcut(createKeyEvent({ repeat: true }))).toBe(false);
        expect(isPlaybackToggleShortcut(createKeyEvent({ isComposing: true }))).toBe(false);
        expect(isPlaybackToggleShortcut(createKeyEvent({ ctrlKey: true }))).toBe(false);
        expect(isPlaybackToggleShortcut(createKeyEvent({ metaKey: true }))).toBe(false);
        expect(isPlaybackToggleShortcut(createKeyEvent({ altKey: true }))).toBe(false);
        expect(isPlaybackToggleShortcut(createKeyEvent({ shiftKey: true }))).toBe(false);
    });

    it('焦点在按钮上时保留按钮自身的空格激活行为', () => {
        expect(isPlaybackToggleShortcut(createEventOn(document.createElement('button')))).toBe(
            false,
        );
    });
});
