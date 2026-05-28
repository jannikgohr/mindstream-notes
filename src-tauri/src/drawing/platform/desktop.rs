//! Desktop bridge for native ink windows.
//!
//! This follows the same event-loop shape as clearlysid's
//! `tauri-plugin-egui`: register a wry plugin, watch Tao window
//! events for the native ink window, and translate those events into
//! the platform-neutral messages consumed by `drawing::render`.

use std::collections::HashMap;
use std::time::Instant;

use tauri_runtime::window::WindowId;
use tauri_runtime::UserEvent;
use tauri_runtime_wry::tao::event::{
    ElementState, Event, MouseButton, MouseScrollDelta, WindowEvent as TaoWindowEvent,
};
use tauri_runtime_wry::tao::event_loop::{ControlFlow, EventLoopProxy, EventLoopWindowTarget};
use tauri_runtime_wry::{Context, EventLoopIterationContext, Message, Plugin, PluginBuilder};
use tauri_runtime_wry::{WebContextStore, WindowMessage};

use crate::drawing::input::{Sample, SampleAction, ToolKind};

const INK_WINDOW_LABEL: &str = "mindstream-ink-note";
const LINE_DELTA_PX: f32 = 60.0;

#[derive(Default)]
pub struct Builder;

impl Builder {
    pub fn new() -> Self {
        Self
    }
}

impl<T: UserEvent> PluginBuilder<T> for Builder {
    type Plugin = DesktopInkPlugin;

    fn build(self, _: Context<T>) -> Self::Plugin {
        DesktopInkPlugin::new()
    }
}

pub struct DesktopInkPlugin {
    windows: HashMap<String, PointerState>,
    start: Instant,
}

impl DesktopInkPlugin {
    fn new() -> Self {
        Self {
            windows: HashMap::new(),
            start: Instant::now(),
        }
    }

    fn event_time_s(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }
}

impl<T: UserEvent> Plugin<T> for DesktopInkPlugin {
    fn on_event(
        &mut self,
        event: &Event<Message<T>>,
        _event_loop: &EventLoopWindowTarget<Message<T>>,
        proxy: &EventLoopProxy<Message<T>>,
        _control_flow: &mut ControlFlow,
        context: EventLoopIterationContext<'_, T>,
        _: &WebContextStore,
    ) -> bool {
        let Event::WindowEvent {
            event, window_id, ..
        } = event
        else {
            return false;
        };
        let Some(label) = get_label_from_tao_id(window_id, &context) else {
            return false;
        };
        if label != INK_WINDOW_LABEL {
            return false;
        }

        let time = self.event_time_s();
        let state = self.windows.entry(label).or_default();
        match event {
            TaoWindowEvent::Resized(size) => {
                crate::drawing::render::resize_surface(size.width.max(1), size.height.max(1));
                request_redraw(window_id, proxy, &context);
                true
            }
            TaoWindowEvent::Destroyed => {
                crate::drawing::render::clear_surface();
                true
            }
            TaoWindowEvent::CursorMoved { position, .. } => {
                state.pointer = Some((position.x as f32, position.y as f32));
                if state.primary_down {
                    push_mouse_sample(state, SampleAction::Move, time);
                    request_redraw(window_id, proxy, &context);
                    true
                } else {
                    false
                }
            }
            TaoWindowEvent::MouseInput {
                state: button_state,
                button,
                ..
            } => {
                if *button != MouseButton::Left {
                    return false;
                }
                let action = if *button_state == ElementState::Pressed {
                    state.primary_down = true;
                    SampleAction::Down
                } else {
                    state.primary_down = false;
                    SampleAction::Up
                };
                push_mouse_sample(state, action, time);
                request_redraw(window_id, proxy, &context);
                true
            }
            TaoWindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = wheel_delta_px(delta);
                if state.ctrl_or_cmd {
                    let scale_delta = (1.0 + dy * 0.0015).clamp(0.2, 5.0);
                    let (focus_x, focus_y) = state.pointer.unwrap_or_default();
                    crate::drawing::render::push_view_gesture(
                        focus_x,
                        focus_y,
                        0.0,
                        0.0,
                        scale_delta,
                    );
                } else {
                    let (focus_x, focus_y) = state.pointer.unwrap_or_default();
                    crate::drawing::render::push_view_gesture(focus_x, focus_y, dx, dy, 1.0);
                }
                request_redraw(window_id, proxy, &context);
                true
            }
            TaoWindowEvent::ModifiersChanged(modifiers) => {
                state.ctrl_or_cmd = modifiers.control_key() || modifiers.super_key();
                false
            }
            _ => false,
        }
    }
}

#[derive(Default)]
struct PointerState {
    pointer: Option<(f32, f32)>,
    primary_down: bool,
    ctrl_or_cmd: bool,
}

fn push_mouse_sample(state: &PointerState, action: SampleAction, time: f64) {
    let (x, y) = state.pointer.unwrap_or_default();
    crate::drawing::render::push_sample(Sample {
        x,
        y,
        pressure: 1.0,
        tool: ToolKind::Mouse,
        buttons: 0,
        action,
        time,
    });
}

fn wheel_delta_px(delta: &MouseScrollDelta) -> (f32, f32) {
    match delta {
        MouseScrollDelta::LineDelta(x, y) => (*x * LINE_DELTA_PX, *y * LINE_DELTA_PX),
        MouseScrollDelta::PixelDelta(pos) => (pos.x as f32, pos.y as f32),
        _ => (0.0, 0.0),
    }
}

fn request_redraw<T: UserEvent>(
    tao_id: &tauri_runtime_wry::tao::window::WindowId,
    proxy: &EventLoopProxy<Message<T>>,
    context: &EventLoopIterationContext<'_, T>,
) {
    if let Some(id) = get_id_from_tao_id(tao_id, context) {
        let _ = proxy.send_event(Message::Window(id, WindowMessage::RequestRedraw));
    }
}

fn get_id_from_tao_id<T: UserEvent>(
    tao_id: &tauri_runtime_wry::tao::window::WindowId,
    context: &EventLoopIterationContext<'_, T>,
) -> Option<WindowId> {
    context.window_id_map.get(tao_id)
}

fn get_label_from_tao_id<T: UserEvent>(
    tao_id: &tauri_runtime_wry::tao::window::WindowId,
    context: &EventLoopIterationContext<'_, T>,
) -> Option<String> {
    get_id_from_tao_id(tao_id, context).and_then(|id| {
        context
            .windows
            .0
            .borrow()
            .get(&id)
            .map(|window| window.label().to_string())
    })
}
