// 键盘快捷键判断工具

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const getTagName = (target: EventTarget | null): string => {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== 'string') {
        return '';
    }
    return element.tagName.toUpperCase();
};

/**
 * 判断事件目标是否是输入类元素（输入框、文本域、下拉框、可编辑内容）。
 * 这些元素获得焦点时不应触发全局快捷键，避免干扰正常输入。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
        return false;
    }
    if (EDITABLE_TAG_NAMES.has(getTagName(element))) {
        return true;
    }
    return element.isContentEditable === true;
}

/**
 * 判断事件是否应触发播放/暂停切换（空格键）。
 * 排除长按重复、输入法组合输入与修饰键组合；焦点在按钮上时保留按钮自身的空格激活行为。
 */
export function isPlaybackToggleShortcut(event: KeyboardEvent): boolean {
    if (event.code !== 'Space' && event.key !== ' ') {
        return false;
    }
    if (event.repeat || event.isComposing) {
        return false;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return false;
    }
    return getTagName(event.target) !== 'BUTTON';
}
