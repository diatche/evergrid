import React from "react";
import {
    Animated,
    AppState,
    GestureResponderEvent,
    InteractionManager,
    PanResponder,
    PanResponderCallbacks,
    PanResponderGestureState,
    PanResponderInstance,
} from "react-native";
import {
    Evergrid,
    ItemView,
    kPanResponderCallbackKeys,
    LayoutSource,
} from "./internal";
import {
    AnimatedValueXYDerivedInput,
    IAnimatedPoint,
    IPoint,
    IAnimationBaseOptions,
    PanPressableOptions,
    PanPressableCallbacks,
} from "./types";
import {
    zeroPoint,
} from "./util";
import {
    concatFunctions,
    negate$,
    normalizeAnimatedDerivedValueXY,
    removeDefaultCurry,
    safeFunction,
} from "./rnUtil";

const kPanSpeedMin = 0.001;

const kWeakViewKey = {};

const kDefaultProps: Required<EvergridLayoutPrimitiveProps> = {
    panEnabled: true,
    verticalPanEnabled: true,
    horizontalPanEnabled: true,
    zIndexStart: 0,
    zIndexStride: 0,
    useNativeDriver: false,
    delayLongPress: 500,
    longPressMaxDistance: 3,
};

export interface IScrollInfo {
    /** Content location in content coordinates. */
    location: IPoint,
    /** Content velocity in content coordinates. */
    velocity: IPoint,
    /** Viewport location in view coordinates (pixels). */
    offset: IPoint,
    /** Viewport velocity in view coordinates (pixels). */
    scaledVelocity: IPoint,
}

/**
 * Note that values returned by pan responder callbacks are ignored.
 **/
export interface EvergridLayoutCallbacks extends PanPressableCallbacks, PanResponderCallbacks {
    snapToLocation?: (info: IScrollInfo) => Partial<IPoint> | undefined;
    onViewportSizeChanged?: (collection: EvergridLayout) => void;
    /**
     * Called when the scale changes.
     */
    onScaleChanged?: (view: EvergridLayout) => void;
}

interface EvergridLayoutPrimitiveProps extends PanPressableOptions {
    /** Enabled by default. */
    panEnabled?: boolean;
    /** Enabled by default. */
    verticalPanEnabled?: boolean;
    /** Enabled by default. */
    horizontalPanEnabled?: boolean;
    /**
     * The first z-index to use when adding layout sources.
     * Defaults to 10.
     * 
     * If a layout source [defines their own]{@link LayoutSourceProps#zIndex}
     * non-zero z-index, this will not override it.
     */
    zIndexStart?: number;
    /**
     * The distance between z-indexes in layout sources.
     * Defaults to 10.
     * 
     * If a layout source [defines their own]{@link LayoutSourceProps#zIndex}
     * non-zero z-index, this will not override it.
     */
    zIndexStride?: number;
    /**
     * **Not Supported**
     * 
     * ~~When `true`, enables performing animations on native side
     * without going through the javascript bridge on every frame.~~
     * Falls back to javascript animation when not supported.
     * See [React Native Documentation](https://reactnative.dev/docs/animated#using-the-native-driver)
     * for more info.
     * 
     * Defaults to `false`.
     **/
    useNativeDriver?: boolean;
}

export interface EvergridLayoutProps extends EvergridLayoutPrimitiveProps {
    layoutSources?: LayoutSource<any>[];
    /** Initial offset in content coordinates. */
    offset?: AnimatedValueXYDerivedInput<EvergridLayout>;
    /** Scale relating content and view coordinate systems. */
    scale?: AnimatedValueXYDerivedInput<EvergridLayout>;
    /**
     * The point with values in the range 0-1.
     * The point represents the origin in the viewport.
     * Scaling also happens about this point.
     * 
     * Defaults to `{ x: 0.5, y: 0.5 }`, i.e. the
     * center of the viewport.
     **/
    anchor?: AnimatedValueXYDerivedInput<EvergridLayout>;
    /**
     * Modify the pan target.
     * Defaults to [viewOffset]{@link EvergridLayout#viewOffset}
     */
    panTarget?: Animated.ValueXY;
    /** Enabled by default. */
    panEnabled?: boolean;
    /** Enabled by default. */
    verticalPanEnabled?: boolean;
    /** Enabled by default. */
    horizontalPanEnabled?: boolean;
    /**
     * The first z-index to use when adding layout sources.
     * Defaults to 10.
     * 
     * If a layout source [defines their own]{@link LayoutSourceProps#zIndex}
     * non-zero z-index, this will not override it.
     */
    zIndexStart?: number;
    /**
     * The distance between z-indexes in layout sources.
     * Defaults to 10.
     * 
     * If a layout source [defines their own]{@link LayoutSourceProps#zIndex}
     * non-zero z-index, this will not override it.
     */
    zIndexStride?: number;
    /**
     * **Not Supported**
     * 
     * ~~When `true`, enables performing animations on native side
     * without going through the javascript bridge on every frame.~~
     * Falls back to javascript animation when not supported.
     * See [React Native Documentation](https://reactnative.dev/docs/animated#using-the-native-driver)
     * for more info.
     * 
     * Defaults to `false`.
     **/
    useNativeDriver?: boolean;
}

export default class EvergridLayout {
    panEnabled: boolean;
    verticalPanEnabled: boolean;
    horizontalPanEnabled: boolean;
    zIndexStart: number;
    zIndexStride: number;
    useNativeDriver: boolean;
    longPressMaxDistance: number;
    delayLongPress: number;

    readonly callbacks: EvergridLayoutCallbacks;

    private _layoutSources: LayoutSource<any>[];
    readonly viewOffset$: Animated.ValueXY;
    /** Animated container size in view coordinates. */
    readonly containerSize$: Animated.ValueXY;
    /** Animated container offset in parent view coordinates. */
    readonly containerOffset$: Animated.ValueXY;
    readonly scale$: Animated.ValueXY;
    /**
     * The point with values in the range 0-1.
     * The point represents the origin in the viewport.
     * Scaling also happens about this point.
     * 
     * Defaults to `{ x: 0.5, y: 0.5 }`, i.e. the
     * center of the viewport.
     **/
    readonly anchor$: Animated.ValueXY;
    readonly panResponder?: PanResponderInstance;
    
    private _weakViewRef: WeakMap<typeof kWeakViewKey, Evergrid>;

    private _locationOffsetBase$: Animated.ValueXY;
    private _locationOffsetBase: IPoint;
    private _scale: IPoint;
    private _hasScale = false;
    private _anchor: IPoint;
    private _panVelocty$: Animated.ValueXY;
    private _panVelocty: IPoint;
    private _panStarted = false;
    private _panDefaultPrevented = false;
    private _panTarget$: Animated.ValueXY;
    private _longPressTimer?: any;
    private _isLongPress = false;
    private _pressInEvent?: GestureResponderEvent;
    private _pressInGestureState?: PanResponderGestureState;
    private _descelerationAnimation?: Animated.CompositeAnimation;
    private _viewOffset: IPoint;
    private _containerSize: IPoint;
    private _hasContainerSize = false;
    private _containerOffset: IPoint;
    private _itemViewCounter = 0;
    private _animatedSubscriptions: { [id: string]: Animated.Value | Animated.ValueXY } = {};
    private _memoryWarningListener?: () => void;
    private _interactionHandle = 0;
    private _updateDepth = 0;
    private _updateTimer?: any;
    // private _mounted = false;

    constructor(options?: EvergridLayoutCallbacks & EvergridLayoutProps) {
        let {
            layoutSources,
            offset,
            scale,
            anchor,
            panTarget,
            panEnabled,
            verticalPanEnabled,
            horizontalPanEnabled,
            zIndexStart,
            zIndexStride,
            useNativeDriver,
            longPressMaxDistance,
            delayLongPress,
            snapToLocation,
            onViewportSizeChanged,
            onScaleChanged,
        } = { ...kDefaultProps, ...options };

        this._weakViewRef = new WeakMap();
        this._layoutSources = [];

        this.zIndexStart = zIndexStart;
        this.zIndexStride = zIndexStride;

        this.useNativeDriver = useNativeDriver || kDefaultProps.useNativeDriver;
        if (this.useNativeDriver) {
            throw new Error('Using native driver is not supported due to limitations with animating layout props.');
        }

        this.longPressMaxDistance = longPressMaxDistance;
        this.delayLongPress = delayLongPress;

        this.callbacks = {
            snapToLocation,
            onViewportSizeChanged,
            onScaleChanged,
        };

        let sub = '';

        this._containerSize = zeroPoint();
        this.containerSize$ = new Animated.ValueXY();
        sub = this.containerSize$.addListener(p => {
            if (p.x <= 0 || p.y <= 0) {
                // console.debug('Ignoring invalid containerSize value: ' + JSON.stringify(p));
                return;
            }
            if (Math.abs(p.x - this._containerSize.x) < 1 && Math.abs(p.y - this._containerSize.y) < 1) {
                return;
            }
            this._containerSize = p;
            this.didChangeContainerSize();
        });
        this._animatedSubscriptions[sub] = this.containerSize$;

        this._containerOffset = zeroPoint();
        this.containerOffset$ = new Animated.ValueXY();
        sub = this.containerOffset$.addListener(p => {
            if (Math.abs(p.x - this._containerOffset.x) < 1 && Math.abs(p.y - this._containerOffset.y) < 1) {
                return;
            }
            this._containerOffset = p;
            this.didChangeContainerOffset();
        });
        this._animatedSubscriptions[sub] = this.containerOffset$;

        this.scale$ = normalizeAnimatedDerivedValueXY(scale, {
            info: this,
            defaults: { x: 1, y: 1}
        });
        this._scale = {
            // @ts-ignore: _value is private
            x: this.scale$.x._value || 0,
            // @ts-ignore: _value is private
            y: this.scale$.y._value || 0,
        };
        sub = this.scale$.addListener(p => {
            if (p.x === 0 || p.y === 0) {
                // console.debug('Ignoring invalid scale value: ' + JSON.stringify(p));
                return;
            }
            if (p.x === this._scale.x && p.y === this._scale.y) {
                return;
            }
            // TODO: Reload all items if scale changes sign.
            this._scale = p;
            this.didChangeScale();
        });
        this._animatedSubscriptions[sub] = this.scale$;

        this.anchor$ = normalizeAnimatedDerivedValueXY(anchor, {
            info: this,
        });
        this._anchor = {
            // @ts-ignore: _value is private
            x: this.anchor$.x._value || 0,
            // @ts-ignore: _value is private
            y: this.anchor$.y._value || 0,
        };
        sub = this.anchor$.addListener(p => {
            if (p.x === this._anchor.x && p.y === this._anchor.y) {
                return;
            }
            this._anchor = p;
            this.didChangeAnchor();
        });
        this._animatedSubscriptions[sub] = this.anchor$;

        this._locationOffsetBase$ = normalizeAnimatedDerivedValueXY(offset, {
            info: this,
        });
        this._locationOffsetBase = {
            // @ts-ignore: _value is private
            x: this._locationOffsetBase$.x._value || 0,
            // @ts-ignore: _value is private
            y: this._locationOffsetBase$.y._value || 0,
        };
        sub = this._locationOffsetBase$.addListener(p => {
            this._locationOffsetBase = p;
            this.didChangeLocation();
        });
        this._animatedSubscriptions[sub] = this._locationOffsetBase$;

        this._viewOffset = zeroPoint();
        this.viewOffset$ = new Animated.ValueXY();
        sub = this.viewOffset$.addListener(p => this._onViewOffsetChange(p));
        this._animatedSubscriptions[sub] = this.viewOffset$;

        this._panTarget$ = panTarget || this.viewOffset$;

        this._panVelocty = zeroPoint();
        this._panVelocty$ = new Animated.ValueXY();
        sub = this._panVelocty$.addListener(p => {
            // console.debug('v: ' + JSON.stringify(p));
            this._panVelocty = p;
        });
        this._animatedSubscriptions[sub] = this._panVelocty$;

        if (!horizontalPanEnabled && !verticalPanEnabled) {
            panEnabled = false;
        }
        this.horizontalPanEnabled = horizontalPanEnabled;
        this.verticalPanEnabled = verticalPanEnabled;
        this.panEnabled = panEnabled;

        if (panEnabled) {
            let panGestureState: Animated.Mapping = {};
            if (horizontalPanEnabled) {
                panGestureState.dx = this._panTarget$.x;
                panGestureState.vx = this._panVelocty$.x;
            }
            if (verticalPanEnabled) {
                panGestureState.dy = this._panTarget$.y;
                panGestureState.vy = this._panVelocty$.y;
            }
            const aquire = () => {
                return (e: GestureResponderEvent): boolean => {
                    if (!panEnabled) {
                        return false;
                    }
                    // e?.preventDefault?.();
                    // this._lockScroll();
                    // console.debug('acquire pan');
                    return true;
                };
            };
            let panConfig: PanResponderCallbacks = {
                onStartShouldSetPanResponder: aquire(),
                // onStartShouldSetPanResponderCapture: aquire(),
                onMoveShouldSetPanResponder: aquire(),
                // onMoveShouldSetPanResponderCapture: aquire(),
                onPanResponderStart: removeDefaultCurry((e, g) => this._onBeginPan(e, g)),
                onPanResponderMove: (...args: any[]) => {
                    if (this._panDefaultPrevented) {
                        return;
                    }
                    Animated.event(
                        [null, panGestureState],
                        {
                            // listener: event => {},
                            useNativeDriver: this.useNativeDriver
                        }
                    )(...args);
                },
                onPanResponderEnd: (e, g) => this._onPressOut(e, g),
                onPanResponderTerminate: (e, g) => this._onPressOut(e, g),
            };
            // Add external callbacks
            for (let cbKey of kPanResponderCallbackKeys) {
                panConfig[cbKey] = concatFunctions(
                    safeFunction(this.callbacks[cbKey]),
                    panConfig[cbKey]
                );
            }
            this.panResponder = PanResponder.create(panConfig);
        }

        this.setLayoutSources(layoutSources || []);
    }

    componentDidMount() {
        // this._mounted = true;
        this._bindToAppEvents();
    }

    componentWillUnmount() {
        // this._mounted = false;
        this.cancelScheduledUpdate();

        this._unbindFromAppEvents();

        this._descelerationAnimation?.stop();
        for (let sub of Object.keys(this._animatedSubscriptions)) {
            let value = this._animatedSubscriptions[sub];
            value.stopAnimation();
            value.removeListener(sub);
        }
        this._animatedSubscriptions = {};

        this._resetLongPress();
    }

    get view(): Evergrid {
        let view = this._maybeView;
        if (!view) {
            throw new Error('View not available');
        }
        return view;
    }

    private get _maybeView(): Evergrid | undefined {
        let view = this._weakViewRef.get(kWeakViewKey);
        if (!view) {
            console.warn(`Evergrid layout requested view, but it is unavailable.`);
        }
        return view;
    }

    set view(view: Evergrid) {
        if (!view || !(view instanceof Evergrid)) {
            throw new Error('Invalid Evergrid view');
        }
        this._weakViewRef.set(kWeakViewKey, view);
    }

    get layoutSources(): LayoutSource[] {
        return [...this._layoutSources];
    }

    setLayoutSources(layoutSources: LayoutSource[]) {
        // let needsRender = false;
        for (let layoutSource of this._layoutSources) {
            if (layoutSources.indexOf(layoutSource) < 0) {
                // Removed layout source
                layoutSource.unconfigure();
                // needsRender = true;
            }
        }

        let previousLayoutSources = this._layoutSources;
        this._layoutSources = [...layoutSources];

        for (let layoutSource of layoutSources) {
            if (previousLayoutSources.indexOf(layoutSource) < 0) {
                // Added layout source
                let i = this._layoutSources.indexOf(layoutSource);
                layoutSource.configure({
                    root: this,
                    zIndex: this.zIndexStart + i * this.zIndexStride,
                });
                // needsRender = true;
            }
        }

        // if (needsRender) {
        //     this.setNeedsRender();
        // }
    }

    get isPanningContent() {
        return this._panStarted && !this._panDefaultPrevented;
    }

    /**
     * Calling this during a panning gesture, stops
     * the panning gesture until the gesture is finished.
     * 
     * This is useful for interacting with content, for example.
     * You can achive this by creating a reference to this node
     * and calling `preventDefaultPan` in `onLongPress` callback.
     */
    preventDefaultPan() {
        if (this._panDefaultPrevented) {
            return;
        }
        this._panDefaultPrevented = true;
        if (this._panStarted) {
            this._onEndPan();
        }
    }

    private _startLongPressTimer() {
        this._resetLongPress();
        let maxDist = this.longPressMaxDistance || kDefaultProps.longPressMaxDistance;
        this._longPressTimer = setTimeout(() => {
            let ev = this._pressInEvent;
            let gestureState = this._pressInGestureState;
            if (!ev || !gestureState) {
                return;
            }
            let { dx, dy } = gestureState;
            if (Math.abs(dx) > maxDist || Math.abs(dy) > maxDist) {
                return;
            }
            this._isLongPress = true;
            this.callbacks.onLongPress?.(ev, gestureState);
        }, this.delayLongPress || kDefaultProps.delayLongPress);
    }

    private _resetLongPress() {
        this._isLongPress = false;
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = undefined;
        }
    }

    private _onViewOffsetChange(p: IPoint) {
        this._viewOffset = p;
        this.setNeedsUpdate();
    }

    private _onBeginPan(
        e: GestureResponderEvent,
        gestureState: PanResponderGestureState
    ) {
        // Since we are reusing a synthetic event,
        // disable event object pooling.
        e.persist();

        this._pressInEvent = e;
        this._pressInGestureState = gestureState;

        this.view.lockScroll();
        this._panStarted = true;
        this._panDefaultPrevented = false;
        this._descelerationAnimation?.stop();
        this._descelerationAnimation = undefined;
        this._panTarget$.setValue(zeroPoint());

        this._startInteraction();

        this.callbacks.onPressIn?.(e, gestureState);
        this._startLongPressTimer();
    }

    private _onPressOut(
        e: GestureResponderEvent,
        gestureState: PanResponderGestureState
    ) {
        this.view.unlockScroll();

        if (this._panStarted) {
            this._onEndPan();
        } else {
            this._endInteration();
        }
        this._panDefaultPrevented = false;

        this.callbacks.onPressOut?.(e, gestureState);
        if (!this._isLongPress) {
            this.callbacks.onPress?.(e, gestureState);
        }
        this._resetLongPress();
    }

    private _onEndPan() {
        this._panStarted = false;

        let handled = this._panDefaultPrevented;
        let {
            locationOffset: offset,
            panVelocity,
            contentVelocity: velocity,
        } = this;

        let isDefaultPan = this._panTarget$ === this.viewOffset$;
        if (isDefaultPan) {
            if (!handled && this.callbacks.snapToLocation) {
                let scrollInfo: IScrollInfo = {
                    location: { ...offset },
                    velocity,
                    offset: this.viewOffset,
                    scaledVelocity: { ...panVelocity },
                };
                let maybeScrollLocation = this.callbacks.snapToLocation(scrollInfo);
                if (typeof maybeScrollLocation !== 'undefined') {
                    // Scroll to location
                    let scrollOffset: IPoint = {
                        ...offset,
                        ...maybeScrollLocation,
                    };
                    this.scrollToOffset({
                        offset: scrollOffset,
                        spring: { velocity },
                        animated: true,
                    });
                    handled = true;
                }
            }

            if (!handled) {
                let isZeroVelocity = Math.abs(panVelocity.x) < kPanSpeedMin && Math.abs(panVelocity.y) < kPanSpeedMin;
                if (!isZeroVelocity) {
                    // Decay velocity
                    this._descelerationAnimation = Animated.decay(
                        this._panTarget$, // Auto-multiplexed
                        {
                            velocity: panVelocity,
                            useNativeDriver: this.useNativeDriver,
                        }
                    );
                    this._onStartDeceleration();
                    this._descelerationAnimation.start(info => this._onEndDeceleration(info));
                } else {
                    this._onEndDeceleration({ finished: true });
                }
                handled = true;
            }
        }

        this._panVelocty = zeroPoint();
    }

    private _onStartDeceleration() {
        this._startInteraction();
    }

    private _onEndDeceleration(info: { finished: boolean }) {
        this._transferViewOffsetToLocation();
        this._panTarget$.setValue(zeroPoint());
        this._descelerationAnimation = undefined;
        this._endInteration();
    }

    private _startInteraction() {
        if (!this._interactionHandle) {
            this._interactionHandle = InteractionManager.createInteractionHandle();
        }
    }

    private _endInteration() {
        if (this._interactionHandle) {
            InteractionManager.clearInteractionHandle(this._interactionHandle);
            this._interactionHandle = 0;
        }
    }

    private _transferViewOffsetToLocation() {
        this.beginUpdate();
        let location = {
            x: this._locationOffsetBase.x + this._viewOffset.x / this._scale.x,
            y: this._locationOffsetBase.y + this._viewOffset.y / this._scale.y,
        };
        this._viewOffset = zeroPoint();
        this._locationOffsetBase = location;
        this._locationOffsetBase$.setValue(location);
        this.endUpdate();
    }

    get containerOriginOffset(): IPoint {
        let { x: x0, y: y0 } = this._anchor;
        let { x: width, y: height } = this.containerSize;
        return {
            // x: -this._viewportInsets.left - width * x0,
            // y: -this._viewportInsets.top - height * y0,
            x: -width * x0,
            y: -height * y0,
        };
    }

    get containerOriginOffset$(): IAnimatedPoint {
        let { x: x0, y: y0 } = this.anchor$;
        let { x: width, y: height } = this.containerSize$;
        return {
            x: negate$(Animated.multiply(
                width,
                x0,
            )),
            y: negate$(Animated.multiply(
                height,
                y0,
            )),
        };
    }

    get locationOffset(): IPoint {
        return {
            x: this._locationOffsetBase.x + this._viewOffset.x / this._scale.x,
            y: this._locationOffsetBase.y + this._viewOffset.y / this._scale.y,
        };
    }

    get locationOffset$(): IAnimatedPoint {
        return {
            x: Animated.add(
                this._locationOffsetBase$.x,
                Animated.divide(
                    this.viewOffset$.x,
                    this.scale$.x,
                ),
            ),
            y: Animated.add(
                this._locationOffsetBase$.y,
                Animated.divide(
                    this.viewOffset$.y,
                    this.scale$.y,
                ),
            ),
        };
    }

    get containerSize(): IPoint {
        return { ...this._containerSize };
    }

    get viewOffset(): IPoint {
        return { ...this._viewOffset };
    }

    get panVelocity(): IPoint {
        return { ...this._panVelocty };
    }

    get contentVelocity(): IPoint {
        return this.unscaleVector(this._panVelocty);
    }

    get needsRender(): boolean {
        return this._maybeView?.needsRender || false;
    }

    setNeedsRender() {
        this._maybeView?.setNeedsRender();
    }

    didChangeContainerSize() {
        this.didChangeViewportSize();
    }

    didChangeContainerOffset() {

    }

    didChangeViewportSize() {
        this.setNeedsUpdate();
        this.callbacks.onViewportSizeChanged?.(this);
    }

    didChangeLocation() {
        this.setNeedsUpdate();
    }

    didChangeScale() {
        this.callbacks.onScaleChanged?.(this);
        this.setNeedsUpdate();
    }

    didChangeAnchor() {
        this.setNeedsUpdate();
    }

    /**
     * Begin a layout update block.
     */
    beginUpdate() {
        this._updateDepth += 1;
    }

    /**
     * End a layout update block.
     */
    endUpdate() {
        this._updateDepth -= 1;
        if (this._updateDepth < 0) {
            this._updateDepth = 0;
            throw new Error('Mismatched begin/end update calls');
        }
        if (this._updateDepth > 0) {
            return;
        }
        this.scheduleUpdate();
    }

    /**
     * Mark that a layout update is needed.
     */
    setNeedsUpdate() {
        // console.debug('setNeedsUpdate');
        this.beginUpdate();
        this.endUpdate();
    }

    get needsUpdate() {
        return this._updateDepth > 0 || !!this._updateTimer;
    }

    /**
     * Schedules a layout update.
     */
    scheduleUpdate() {
        if (this._updateTimer) {
            return;
        }
        // console.debug(`scheduleUpdate`);
        // this._updateTimer = setTimeout(() => {
        //     this._updateTimer = 0;
        //     this.update();
        // }, 1);
        this.update();
    }

    /**
     * Call to update layout immediately.
     * Consider calling `scheduleUpdate` instead of
     * this method to improve performance.
     */
    update() {
        // console.debug(`update`);
        this.cancelScheduledUpdate();

        if (!this._hasContainerSize) {
            if (this._containerSize.x >= 1 && this._containerSize.y >= 1) {
                this._hasContainerSize = true;
            } else {
                // Wait for a valid container size before updating
                return;
            }
        }
        if (!this._hasScale) {
            if (this._scale.x !== 0 && this._scale.y !== 0) {
                this._hasScale = true;
            } else {
                // Wait for a valid scale before updating
                return;
            }
        }

        for (let layoutSource of this._layoutSources) {
            layoutSource.setNeedsUpdate();
        }

        // if (this.needsRender) {
        //     // Schedule render after updates only
        //     this.scheduleRender();
        // }
    }

    cancelScheduledUpdate() {
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = 0;
        }
    }

    get scale(): IPoint {
        return { ...this._scale };
    }

    getVisibleLocationRange(): [IPoint, IPoint] {
        let { x: width, y: height } = this.containerSize;
        if (width < 1 || height < 1) {
            return [zeroPoint(), zeroPoint()];
        }
        let { x, y } = this.viewOffset;
        let scale = this.scale;
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
        let start = this.getLocation(startOffset);
        let end = this.getLocation(endOffset);
        if (start.x >= end.x || start.y >= end.y) {
            return [zeroPoint(), zeroPoint()];
        }
        return [start, end];
    }

    /**
     * Transforms a vector in content coordinates
     * to a vector in view coordinates (pixels).
     * @param point 
     */
    scaleVector(point: IPoint): IPoint {
        return {
            x: point.x * this._scale.x,
            y: point.y * this._scale.y,
        };
    }

    /**
     * Transforms an animated vector in content coordinates
     * to an animated vector in view coordinates (pixels).
     * @param point 
     */
    scaleVector$(point: IAnimatedPoint): IAnimatedPoint {
        return {
            x: Animated.multiply(point.x, this.scale$.x),
            y: Animated.multiply(point.y, this.scale$.y),
        };
    }

    /**
     * Transforms an animated size in content coordinates
     * to an animated size in view coordinates (pixels).
     * 
     * Accounts for negative scale.
     * 
     * @param size 
     */
    scaleSize$(size: IAnimatedPoint): IAnimatedPoint {
        let { scale } = this;
        let scaledSize = {
            x: Animated.multiply(size.x, this.scale$.x),
            y: Animated.multiply(size.y, this.scale$.y),
        };
        if (scale.x < 0) {
            scaledSize.x = negate$(scaledSize.x);
        }
        if (scale.y < 0) {
            scaledSize.y = negate$(scaledSize.y);
        }
        return scaledSize;
    }

    /**
     * Transforms a vector in view coordinates (pixels)
     * to a vector in content coordinates.
     * @param point 
     */
    unscaleVector(point: IPoint): IPoint {
        if (this._scale.x === 0 || this._scale.y === 0) {
            return zeroPoint();
        }
        return {
            x: point.x / this._scale.x,
            y: point.y / this._scale.y,
        };
    }

    getContainerLocationWithEvent(event: GestureResponderEvent): IPoint {
        return {
            x: -event.nativeEvent.locationX,
            y: -event.nativeEvent.locationY,
        };
    }

    /**
     * Transforms a point in content coordinates
     * to a point in container coordinates.
     * @param point 
     */
    getContainerLocation(
        point: IPoint,
        options?: {
            scale?: Partial<IPoint>;
        }
    ): IPoint {
        let { x: xl0, y: yl0 } = this._locationOffsetBase;
        let { x: x0, y: y0 } = this.containerOriginOffset;
        let cp: IPoint = {
            x: this._viewOffset.x - x0,
            y: this._viewOffset.y - y0,
        };
        let scale: IPoint = {
            x: this._scale.x,
            y: this._scale.y,
        };
        if (options?.scale) {
            if (options.scale.x) {
                scale.x *= options.scale.x;
            }
            if (options.scale.y) {
                scale.y *= options.scale.y;
            }
        }
        cp.x += (point.x + xl0) * scale.x;
        cp.y += (point.y + yl0) * scale.y;
        return cp;
    }

    /**
     * Transforms a point in content coordinates
     * to a point in container coordinates.
     * @param point 
     */
    getContainerLocation$(
        point: IAnimatedPoint | Animated.ValueXY,
        options?: {
            scale?: Partial<IAnimatedPoint> | Partial<Animated.ValueXY>;
        }
    ): IAnimatedPoint {
        let { x: xl0, y: yl0 } = this._locationOffsetBase$;
        let { x: x0, y: y0 } = this.containerOriginOffset$;
        let cp: IAnimatedPoint = {
            x: Animated.subtract(
                this.viewOffset$.x,
                x0,
            ),
            y: Animated.subtract(
                this.viewOffset$.y,
                y0,
            ),
        };
        let scale: IAnimatedPoint = {
            x: this.scale$.x,
            y: this.scale$.y,
        };
        if (options?.scale) {
            if (options.scale.x) {
                scale.x = Animated.multiply(scale.x, options.scale.x);
            }
            if (options.scale.y) {
                scale.y = Animated.multiply(scale.y, options.scale.y);
            }
        }
        cp.x = Animated.add(
            cp.x,
            Animated.multiply(
                Animated.add(
                    point.x,
                    xl0,
                ),
                scale.x,
            ),
        );
        cp.y = Animated.add(
            cp.y,
            Animated.multiply(
                Animated.add(
                    point.y,
                    yl0,
                ),
                scale.y,
            ),
        );
        return cp;
    }

    /**
     * Transforms a point in view coordinates (pixels)
     * to a point in content coordinates.
     * @param point 
     */
    getLocation(point: IPoint): IPoint {
        if (this._scale.x === 0 || this._scale.y === 0) {
            return zeroPoint();
        }
        let { x: xl0, y: yl0 } = this._locationOffsetBase;
        let { x: x0, y: y0 } = this.containerOriginOffset;
        return {
            x: -xl0 - (point.x - x0) / this._scale.x,
            y: -yl0 - (point.y - y0) / this._scale.y,
        };
    }

    scrollBy(
        options: { offset: Partial<IPoint> } & IAnimationBaseOptions
    ): Animated.CompositeAnimation | undefined {
        let offset = { ...this._locationOffsetBase };
        let hasOffset = false;
        if (typeof options.offset.x !== 'undefined') {
            offset.x += options.offset.x;
            hasOffset = true;
        }
        if (typeof options.offset.y !== 'undefined') {
            offset.y += options.offset.y;
            hasOffset = true;
        }
        if (!hasOffset) {
            return;
        }
        return this.scrollToOffset({
            ...options,
            offset,
        });
    }

    scrollToOffset(
        options: { offset: Partial<IPoint> } & IAnimationBaseOptions
    ): Animated.CompositeAnimation | undefined {
        if (this._panStarted) {
            return;
        }
        let offset = { ...this._locationOffsetBase };
        let hasOffset = false;
        if (typeof options.offset.x !== 'undefined') {
            offset.x = options.offset.x;
            hasOffset = true;
        }
        if (typeof options.offset.y !== 'undefined') {
            offset.y = options.offset.y;
            hasOffset = true;
        }
        if (!hasOffset) {
            return;
        }
        // console.debug(`scrollToOffset: ${JSON.stringify(offset)}`);
        
        this._descelerationAnimation?.stop();
        this._descelerationAnimation = undefined;

        this._startInteraction();
        this._transferViewOffsetToLocation();

        if (!options.animated) {
            this._locationOffsetBase$.setValue(offset);
            let info = { finished: true };
            this._onEndDeceleration(info);
            options.onEnd?.(info);
            return;
        }

        if (options.timing) {
            this._descelerationAnimation = Animated.timing(
                this._locationOffsetBase$,
                {
                    toValue: offset,
                    ...options.timing,
                    useNativeDriver: this.useNativeDriver,
                }
            );
        } else {
            this._descelerationAnimation = Animated.spring(
                this._locationOffsetBase$, // Auto-multiplexed
                {
                    toValue: offset,
                    velocity: options.spring?.velocity || this.contentVelocity,
                    bounciness: 0,
                    ...options.spring,
                    useNativeDriver: this.useNativeDriver,
                }
            );
        }
        if (!options.manualStart) {
            this._onStartDeceleration();
            this._descelerationAnimation.start(info => {
                this._onEndDeceleration(info);
                options.onEnd?.(info);
            });
        } else {
            this._endInteration();
        }
        return this._descelerationAnimation;
    }

    createItemViewRef(): React.RefObject<ItemView> {
        return React.createRef<ItemView>();
    }

    createItemViewKey(): string {
        return String(++this._itemViewCounter);
    }

    // private _updateLayoutSources() {
    //     for (let layoutSource of this._layoutSources) {
    //         this._updateLayoutSource(layoutSource);
    //     }
    // }

    // private _updateLayoutSource<T>(layoutSource: LayoutSource<T>) {
    //     console.debug(`[${layoutSource.id}] begin prerender`);
    //     layoutSource.updateItems(this, { prerender: true });
    //     console.debug(`[${layoutSource.id}] end prerender`);
    // }

    private _bindToAppEvents() {
        if (!this._memoryWarningListener) {
            // Clear queue on memroy warning
            this._memoryWarningListener = () => {
                console.warn('Clearing queue due to memory warning');
                for (let layoutSource of this._layoutSources) {
                    layoutSource.clearQueue();
                }
            };
            AppState.addEventListener(
                'memoryWarning',
                this._memoryWarningListener,
            );
        }
    }

    private _unbindFromAppEvents() {
        if (this._memoryWarningListener) {
            AppState.removeEventListener(
                'memoryWarning',
                this._memoryWarningListener,
            );
            this._memoryWarningListener = undefined;
        }
    }
}