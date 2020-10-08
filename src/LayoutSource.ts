import { Animated } from "react-native";
import { kInsetKeys, kZeroInsets } from "./const";
import {
    AnimatedValueDerivedInput,
    IAnimatedPoint,
    IInsets,
    IItemLayout,
    ILayout,
    MutableAnimatedPoint,
    RecyclerGridView as Grid,
} from "./internal";
import {
    AnimatedValueXYDerivedInput,
    IItem,
    IItemUpdate,
    InsetEdge,
    IPoint,
} from "./types";
import {
    getLazyArray,
    zeroPoint,
} from "./util";
import {
    negate$,
    normalizeAnimatedValue,
    normalizeAnimatedValueXY,
} from './rnUtil';

const kDefaultProps: Partial<LayoutSourceProps<any>> = {
    showDuration: 150,
};

let _layoutSourceCounter = 0;

export interface LayoutSourceProps<T> {
    itemSize?: AnimatedValueXYDerivedInput<Grid>;
    origin?: AnimatedValueXYDerivedInput<Grid>;
    scale?: AnimatedValueXYDerivedInput<Grid>;
    insets?: Partial<IInsets<AnimatedValueDerivedInput<Grid>>>;
    /**
     * The subviews "stick" to the specified edge.
     * The `origin` determines which location "sticks".
     * To offset from the edge, use the corresponding edge
     * in `insets`.
     **/
    stickyEdge?: InsetEdge;
    /**
     * Setting a non-zero z-index here will set the default
     * z-index for all items.
     * 
     * By default, the view sets the z-index such that the
     * visual order of items matches the order in which the
     * layout source were added to the view. Customise this
     * behaviour [in the view]{@link RecyclerCollectionViewProps}.
     * 
     * You can also set each item's z-index individually
     * in the item's layout callback. Refer to the subclasses
     * item layout method for more information.
     */
    zIndex?: number;
    reuseID?: string;
    /**
     * All items are reused by default.
     * 
     * Passing an empty string does not reuse that item.
     **/
    getReuseID?: (index: T) => string;
    /**
     * Rendering to DOM is an expensive operation. If a
     * render of this item is not needed on update,
     * return `false`, otherwise return `true`.
     * 
     * This method is called only when an item is reused,
     * not when it is created.
     **/
    shouldRenderItem: (data: {
        item: IItem<T>;
        previous: Pick<IItem<T>, 'index' | 'contentLayout'>;
    }) => boolean;
    /**
     * Called before an item is displayed after
     * an update or creation.
     */
    willShowItem?: (item: IItem<T>) => void;
    /**
     * Called before an item is hidden after
     * moving out of visible bounds.
     */
    willHideItem?: (item: IItem<T>) => void;
    /**
     * The duration in milliseconds of the fade-in animation,
     * when a new item is rendered. Ignored when an item is
     * reused.
     * 
     * This reduces the jarring effect of items suddenly appearing
     * after rendering. When items are reused, this is irrelevant
     * as they are shown immediately.
     */
    showDuration?: number;
}

export default class LayoutSource<
    T = any,
    Props extends LayoutSourceProps<T> = LayoutSourceProps<T>
> {
    props: Props;
    readonly id: string;
    itemSize$: Animated.ValueXY;
    origin$: Animated.ValueXY;
    scale$: Animated.ValueXY;
    insets$: IInsets<Animated.Value>;

    private _itemSize: IPoint;
    private _origin: IPoint;
    private _scale: IPoint;
    private _insets: IInsets<number>;
    private _zIndex = 0;

    private _itemQueues: { [reuseID: string]: IItem<T>[] };
    private _animatedSubscriptions: { [id: string]: Animated.Value | Animated.ValueXY } = {};
    private _updating = false;

    constructor(props: Props) {
        this.props = {
            ...kDefaultProps,
            ...props,
        };
        this.id = String(++_layoutSourceCounter);
        this._itemQueues = {};

        this.itemSize$ = new Animated.ValueXY();
        this._itemSize = { x: 1, y: 1 };

        this.origin$ = new Animated.ValueXY();
        this._origin = zeroPoint();

        this._scale = { x: 1, y: 1 };
        this.scale$ = new Animated.ValueXY({ ...this._scale });

        this.insets$ = {
            top: new Animated.Value(0),
            right: new Animated.Value(0),
            bottom: new Animated.Value(0),
            left: new Animated.Value(0),
        };
        this._insets = { ...kZeroInsets };
    }

    get itemSize(): IPoint {
        return { ...this._itemSize };
    }

    get origin(): IPoint {
        return { ...this._origin };
    }

    get scale(): IPoint {
        return { ...this._scale };
    }

    get zIndex(): number {
        return this.props.zIndex || this._zIndex;
    }

    configure(view: Grid, options?: { zIndex?: number }) {
        this.unconfigure();

        let needsForcedUpdate = false;
        let sub = '';

        this.itemSize$ = normalizeAnimatedValueXY(this.props.itemSize, view);
        this._itemSize = {
            // @ts-ignore: _value is private
            x: this.itemSize$.x._value || 0,
            // @ts-ignore: _value is private
            y: this.itemSize$.y._value || 0,
        };
        sub = this.itemSize$.addListener(p => {
            this._itemSize = p;
            this.setNeedsUpdate(view);
        });
        this._animatedSubscriptions[sub] = this.itemSize$;

        this.origin$ = normalizeAnimatedValueXY(this.props.origin, view);
        this._origin = {
            // @ts-ignore: _value is private
            x: this.origin$.x._value || 0,
            // @ts-ignore: _value is private
            y: this.origin$.y._value || 0,
        };
        sub = this.origin$.addListener(p => {
            this._origin = p;
            this.setNeedsUpdate(view);
        });
        this._animatedSubscriptions[sub] = this.origin$;

        this.scale$ = normalizeAnimatedValueXY(this.props.scale, view, this._scale);
        this._scale = {
            // @ts-ignore: _value is private
            x: this.scale$.x._value || 0,
            // @ts-ignore: _value is private
            y: this.scale$.y._value || 0,
        };
        sub = this.scale$.addListener(p => {
            if (p.x === 0 || p.y === 0) {
                console.debug('Ignoring invalid scale value: ' + JSON.stringify(p));
                return;
            }
            if (p.x === this._scale.x && p.y === this._scale.y) {
                return;
            }
            this._scale = p;
            this.setNeedsUpdate(view);
        });
        this._animatedSubscriptions[sub] = this.scale$;

        kInsetKeys.forEach(insetKey => {
            let currentInset$ = this.insets$[insetKey];
            let inset$ = normalizeAnimatedValue(this.props.insets?.[insetKey], view, currentInset$);
            if (currentInset$ !== inset$) {
                // Modify animated value
                this.insets$[insetKey] = inset$;
                needsForcedUpdate = true;
            }
            // @ts-ignore: _value is private
            this._insets[insetKey] = inset$._value || 0;
            let sub = inset$.addListener(({ value }) => {
                if (Math.abs(value - this._insets[insetKey]) < 1) {
                    return;
                }
                this._insets[insetKey] = value;
                this.setNeedsUpdate(view);
            });
            this._animatedSubscriptions[sub] = inset$;
        });

        this._zIndex = options?.zIndex || 0;

        if (needsForcedUpdate) {
            this.setNeedsUpdate(view, { force: true });
        }
    }

    unconfigure() {
        for (let sub of Object.keys(this._animatedSubscriptions)) {
            let value = this._animatedSubscriptions[sub];
            value.removeListener(sub);
        }
        this._animatedSubscriptions = {};
        this.reset();
    }

    reset() {
        this.clearQueue();
        for (let index of this.visibleIndexes()) {
            if (this.props.willHideItem) {
                let item = this.getVisibleItem(index);
                if (item) {
                    this.props.willHideItem(item);
                }
            }
            this.setVisibleItem(index, undefined);
        }
    }

    * itemUpdates(): Generator<IItemUpdate<T>> {
        throw new Error('Not implemented');
    }

    * visibleIndexes(): Generator<T> {
        throw new Error('Not implemented');
    }

    setNeedsUpdate(view: Grid, options?: { force?: boolean }) {
        let { force = false } = options || {};
        if (!force && view.needsRender) {
            // View will render anyway
            return;
        }
        if (force || this.shouldUpdate(view)) {
            this.updateItems(view);
        }
    }

    /**
     * Return true when a layout update is needed.
     * @param view 
     */
    shouldUpdate(view: Grid) {
        return true;
    }

    /**
     * Called when an update begins.
     * 
     * Subclasses must call the super implementation first.
     * @param view 
     */
    beginUpdate(view: Grid) {
        if (this._updating) {
            this._updating = false;
            throw new Error('Already updating');
        }
        this._updating = true;
        // console.debug(`[${this.id}] ` + 'beginUpdate');
    }

    /**
     * Called when an update is commited.
     * 
     * Subclasses must call the super implementation last.
     * @param view 
     */
    commitUpdate(view: Grid) {
        // console.debug(`[${this.id}] ` + 'commitUpdate');
        this.endUpdate(view);
    }

    /**
     * Called when an update is cancelled.
     * 
     * Subclasses must call the super implementation last.
     * @param view 
     */
    cancelUpdate(view: Grid) {
        // console.debug(`[${this.id}] ` + 'cancelUpdate');
        this.endUpdate(view);
    }

    /**
     * Called when an update is committed or cancelled.
     * 
     * Subclasses must call the super implementation last.
     * @param view 
     */
    endUpdate(view: Grid) {
        // console.debug(`[${this.id}] ` + 'endUpdate');
        this._commitPendingItemQueues();
        // this._needsUpdate = false;
        this._updating = false;
    }

    getVisibleLocationRange(view: Grid): [IPoint, IPoint] {
        let { x: width, y: height } = this.getViewportSize(view);
        if (width < 1 || height < 1) {
            return [zeroPoint(), zeroPoint()];
        }
        let { x, y } = this.getViewportOffset(view);
        let scale = this.getScale(view);
        let startOffset = {
            x: Math.ceil(x),
            y: Math.floor(y),
        };
        let endOffset = {
            x: Math.floor(x - width),
            y: Math.ceil(y - height),
        };
        if (scale.x < 0) {
            let xSave = startOffset.x;
            startOffset.x = endOffset.x
            endOffset.x = xSave;
        }
        if (scale.y < 0) {
            let ySave = startOffset.y;
            startOffset.y = endOffset.y
            endOffset.y = ySave;
        }
        let start = this.getLocation(startOffset, view);
        let end = this.getLocation(endOffset, view);
        if (start.x > end.x || start.y > end.y) {
            return [zeroPoint(), zeroPoint()];
        }
        return [start, end];
    }

    getVisibleGridIndexRange(
        view: Grid,
        options?: {
            partial?: boolean
        }
    ): [IPoint, IPoint] {
        let range = this.getVisibleLocationRange(view);
        range[0] = this.getGridIndex(range[0], view);
        range[1] = this.getGridIndex(range[1], view);
        if (!options?.partial) {
            range[0].x = Math.floor(range[0].x);
            range[0].y = Math.floor(range[0].y);
            range[1].x = Math.ceil(range[1].x);
            range[1].y = Math.ceil(range[1].y);
        }
        return range;
    }

    getStickyContainerLocation(view: Grid): Partial<IPoint> {
        if (!this.props.stickyEdge) {
            return {};
        }
        switch (this.props.stickyEdge) {
            case 'top':
                return { y: this._insets.top };
            case 'left':
                return { x: this._insets.left };
            default:
                break;
        }
        let size = view.containerSize;
        switch (this.props.stickyEdge) {
            case 'bottom':
                return {
                    y: size.y - this._insets.bottom,
                };
            case 'right':
                return {
                    x: size.x - this._insets.right,
                };
            default:
                throw new Error('Invalid inset');
        }
    }

    getStickyContainerLocation$(view: Grid): Partial<IAnimatedPoint> {
        if (!this.props.stickyEdge) {
            return {};
        }
        switch (this.props.stickyEdge) {
            case 'top':
                return { y: this.insets$.top };
            case 'left':
                return { x: this.insets$.left };
            default:
                break;
        }
        let size = view.containerSize$;
        switch (this.props.stickyEdge) {
            case 'bottom':
                return {
                    y: Animated.subtract(
                        size.y,
                        this.insets$.bottom,
                    )
                };
            case 'right':
                return {
                    x: Animated.subtract(
                        size.x,
                        this.insets$.right,
                    )
                };
            default:
                throw new Error('Invalid inset');
        }
    }

    getContainerLocation(point: IPoint, view: Grid): IPoint {
        let { x, y } = view.getContainerLocation(point, {
            scale: this.scale
        });
        let p = this.getStickyContainerLocation(view);
        let scale = this.getScale(view);
        
        if (typeof p.x === 'undefined') {
            if (scale.x > 0) {
                p.x = x + this._insets.left;
            } else {
                p.x = x - this._insets.right;
            }
        }
        p.x = p.x || 0 + this._origin.x * scale.x;

        if (typeof p.y === 'undefined') {
            if (scale.y > 0) {
                p.y = y + this._insets.top;
            } else {
                p.y = y - this._insets.bottom;
            }
        }
        p.y = p.y || 0 + this._origin.y * scale.y;
        return p as IPoint;
    }

    getContainerLocation$(point: IAnimatedPoint | Animated.ValueXY, view: Grid): IAnimatedPoint {
        let { x, y } = view.getContainerLocation$(point, {
            scale: this.scale$
        });
        let p = this.getStickyContainerLocation$(view);
        let scale = this.getScale(view);
        let scale$ = this.getScale$(view);
        
        if (typeof p.x === 'undefined') {
            if (scale.x > 0) {
                p.x = Animated.add(
                    x,
                    this.insets$.left,
                );
            } else {
                p.x = Animated.subtract(
                    x,
                    this.insets$.right,
                );
            }
        }
        p.x = Animated.add(
            p.x,
            Animated.multiply(
                this.origin$.x,
                scale$.x,
            ),
        );

        if (typeof p.y === 'undefined') {
            if (scale.y > 0) {
                p.y = Animated.add(
                    y,
                    this.insets$.top,
                );
            } else {
                p.y = Animated.subtract(
                    y,
                    this.insets$.bottom,
                );
            }
        }
        p.y = Animated.add(
            p.y,
            Animated.multiply(
                this.origin$.y,
                scale$.y,
            ),
        );
        return p as IAnimatedPoint;
    }

    getScale(view: Grid): IPoint {
        let { scale } = view;
        return {
            x: this._scale.x * scale.x,
            y: this._scale.y * scale.y,
        };
    }

    getScale$(view: Grid): IAnimatedPoint {
        let { scale$ } = view;
        return {
            x: Animated.multiply(this.scale$.x, scale$.x),
            y: Animated.multiply(this.scale$.y, scale$.y),
        };
    }

    /**
     * Transforms a point in view coordinates (offset)
     * to a point in content coordinates.
     * @param point 
     */
    getLocation(point: IPoint, view: Grid): IPoint {
        let { x, y } = view.getLocation(point);
        let offset = this.getLocationInsetOffset(view);
        return {
            x: x - this._origin.x + offset.x,
            y: y - this._origin.y + offset.y,
        };
    }

    /**
     * Returns the amount to offset a location
     * when converting from view to content
     * coordinates.
     */
    getLocationInsetOffset(view: Grid): IPoint {
        let scale = this.getScale(view);
        return {
            x: Math.max(this._insets.left / scale.x, -this._insets.right / scale.x),
            y: Math.max(this._insets.top / scale.y, -this._insets.bottom / scale.y),
        };
    }

    /**
     * Transforms a point in content coordinates
     * to an index of a grid of size `itemSize`.
     * @param point 
     */
    getGridIndex(point: IPoint, view: Grid): IPoint {
        let { itemSize } = this;
        // return {
        //     x: point.x / itemSize.x,
        //     y: point.y / itemSize.y,
        // };
        let offset = this.getLocationInsetOffset(view);
        return {
            x: (point.x - offset.x) / itemSize.x,
            y: (point.y - offset.y) / itemSize.y,
        };
    }

    getViewportOffset(view: Grid): IPoint {
        let { x, y } = view.viewOffset;
        let scale = this.getScale(view);
        return {
            x: x + (scale.x > 0 ? this._insets.left : -this._insets.right),
            y: y + (scale.y > 0 ? -this._insets.top : this._insets.bottom),
        };
    }
    
    getViewportSize(view: Grid): IPoint {
        let { x, y } = view.containerSize;
        return {
            x: x - this._insets.left - this._insets.right,
            y: y - this._insets.top - this._insets.bottom,
        };
    }

    getItemContentLayout(index: T): IItemLayout {
        throw new Error('Not implemented');
    }

    getItemViewLayout(contentLayout: ILayout<IPoint>, view: Grid): IItemLayout {
        let scale = this.getScale(view);
        let layout: ILayout<IPoint> = {
            offset: this.getContainerLocation(contentLayout.offset, view),
            size: {
                x: contentLayout.size.x * scale.x,
                y: contentLayout.size.y * scale.y,
            }
        };
        if (scale.x < 0) {
            let widthOffset = layout.size.x;
            layout.offset.x = layout.offset.x + widthOffset;
            layout.size.x = -layout.size.x;
        }
        if (scale.y < 0) {
            let heightOffset = layout.size.y;
            layout.offset.y = layout.offset.y + heightOffset;
            layout.size.y = -layout.size.y;
        }
        return layout;
    }

    createItemContentLayout$(): ILayout<MutableAnimatedPoint> {
        return {
            offset: new Animated.ValueXY(),
            size: new Animated.ValueXY(),
        };
    }

    createItemViewLayout$(contentLayout$: ILayout<MutableAnimatedPoint>, view: Grid): ILayout<IAnimatedPoint> {
        let scale$ = this.getScale$(view);
        let layout: ILayout<IAnimatedPoint> = {
            offset: this.getContainerLocation$(contentLayout$.offset, view),
            size: {
                x: Animated.multiply(contentLayout$.size.x, scale$.x),
                y: Animated.multiply(contentLayout$.size.y, scale$.y),
            }
        };
        let scale = this.getScale(view);
        if (scale.x < 0) {
            let widthOffset = layout.size.x;
            layout.offset.x = Animated.add(layout.offset.x, widthOffset);
            layout.size.x = negate$(layout.size.x);
        }
        if (scale.y < 0) {
            let heightOffset = layout.size.y;
            layout.offset.y = Animated.add(layout.offset.y, heightOffset);
            layout.size.y = negate$(layout.size.y);
        }
        return layout;
    }

    getReuseID(index: T): string {
        if (this.props.getReuseID) {
            return this.props.getReuseID(index) || '';
        } else if (typeof this.props.reuseID !== 'undefined') {
            return this.props.reuseID;
        } else {
            return this.id;
        }
    }

    createItem(index: T, view: Grid) {
        let contentLayout = this.createItemContentLayout$();
        let viewLayout = this.createItemViewLayout$(contentLayout, view);
        
        let item: IItem<T> = {
            index,
            ref: view.createItemViewRef(),
            zIndex: this.zIndex,
            contentLayout: {
                offset: zeroPoint(),
                size: zeroPoint(),
            },
            animated: {
                contentLayout,
                viewLayout,
                opacity: new Animated.Value(0),
                renderNonce: new Animated.Value(0),
            },
        };
        item.reuseID = this.getReuseID(index);

        // console.debug(`[${this.id}] created (${item.reuseID}) at ${JSON.stringify(index)}`);
        this.updateItem(item, index, { isNew: true });
        return item;
    }

    updateItem(
        item: IItem<T>,
        index: T,
        options?: {
            isNew?: boolean;
        }
    ) {
        let previousContentLayout = item.contentLayout;
        item.contentLayout = {
            ...item.contentLayout,
            ...this.getItemContentLayout(index),
        };
        if (!item.zIndex) {
            item.zIndex = this.zIndex;
        }
        // console.debug(`[${this.id}] content layout ${JSON.stringify(index)}: ${JSON.stringify(item.contentLayout, null, 2)}`);
        let { offset, size } = item.contentLayout;
        let {
            offset: offset$,
            size: size$,
        } = item.animated.contentLayout;
        if (offset) {
            if (offset.x !== previousContentLayout.offset.x) {
                offset$.x.setValue(offset.x);
            }
            if (offset.y !== previousContentLayout.offset.y) {
                offset$.y.setValue(offset.y);
            }
        }
        if (size) {
            if (size.x !== previousContentLayout.size.x) {
                size$.x.setValue(size.x);
            }
            if (size.y !== previousContentLayout.size.y) {
                size$.y.setValue(size.y);
            }
        }

        // Determine when to show item:
        // Updated items are shown instantly
        let showNow = !options?.isNew;
        if (!showNow) {
            // Animate opacity to reduce jarring effect
            // in ItemView render (if duration given).
            let { showDuration = 0 } = this.props;
            showNow = showDuration <= 0;
        }
        if (showNow) {
            item.animated.opacity.setValue(1);
        }
        this.props.willShowItem?.(item);
        this.setVisibleItem(index, item);
    }

    getVisibleItem(index: T): IItem<T> | undefined {
        throw new Error('Not implemented');
    }

    setVisibleItem(index: T, item: IItem<T> | undefined) {
        throw new Error('Not implemented');
    }

    private _dequeueItem(reuseID: string): IItem<T> | undefined {
        let queue = getLazyArray(this._itemQueues, reuseID);
        let item = queue.pop();
        if (item && item.reuseID !== reuseID) {
            console.error(`Dequeued an item from queue with reuseID "${reuseID}" with a different reuseID "${item.reuseID}"`);
        }
        // if (item) {
        //     console.debug(`[${this.id}] dequeued ${reuseID} (size: ${queue.length})`);
        // } else {
        //     console.debug(`[${this.id}] queue empty (${reuseID})`);
        // }
        return item;
    }

    queueItem(index: T) {
        let item = this.getVisibleItem(index);
        if (!item) {
            // console.debug(`[${this.id}] queue ${JSON.stringify(index)} failed`);
            return false;
        }
        this.props.willHideItem?.(item);
        this.setVisibleItem(index, undefined);
        item.animated.opacity.setValue(0);
        if (item.reuseID) {
            let queue = getLazyArray(this._itemQueues, item.reuseID);
            queue.push(item);
            // console.debug(`[${this.id}] queued ${JSON.stringify(index)} (${item.reuseID}, size: ${queue.length})`);
        }
        return true;
    }

    private _commitPendingItemQueues() {
        // TODO: Set opacity of newly queued items to 0
    }

    clearQueue() {
        this._itemQueues = {};
    }

    updateItems(
        view: Grid,
        options?: {
            queue?: boolean;
            dequeue?: boolean;
            create?: boolean;
            update?: boolean;
        }
    ) {
        let {
            queue = true,
            dequeue = true,
            create = false,
            update = false,
        } = options || {};
        // console.debug(`[${this.id}] ` + 'updateItems');
        this.beginUpdate(view);
        try {
            for (let { add, remove } of this.itemUpdates()) {
                if (queue && typeof remove !== 'undefined') {
                    // Item hidden
                    // console.debug(`[${this.id}] ` + 'hide: ' + JSON.stringify(remove));
                    this.queueItem(remove);
                } else if (typeof add !== 'undefined') {
                    // Item shown
                    // console.debug(`[${this.id}] ` + 'show: ' + JSON.stringify(add));
                    if (!dequeue || !this.dequeueItem(add)) {
                        if (create) {
                            this.createItem(add, view);
                        } else {
                            this.cancelUpdate(view);
                            view.setNeedsRender();
                            return;
                        }
                    }
                    // else {
                    //     // console.debug(`[${this.id}] ` + 'dequeued: ' + JSON.stringify(add));
                    // }
                }
            }
            if (update) {
                for (let index of this.visibleIndexes()) {
                    let item = this.getVisibleItem(index);
                    if (item) {
                        this.updateItem(item, index);
                    }
                }
            }
            this.commitUpdate(view);
        } catch (error) {
            console.error('Error during update: ' + error?.message || error);
            this.cancelUpdate(view);
        }
    }

    dequeueItem(index: T): IItem<T> | undefined {
        let reuseID = this.getReuseID(index);
        let item = this._dequeueItem(reuseID);
        if (item) {
            let previous = {
                index: item.index,
                contentLayout: { ...item.contentLayout },
            };
            this.updateItem(item, index);
            if (this.props.shouldRenderItem({ item, previous })) {
                // TODO: Do not update nonce immediately, wait for commit.
                // This will avoid an extra item render if a container render is needed.
                item.animated.renderNonce.setValue(new Date().valueOf());
            }
        }
        return item;
    }
}
