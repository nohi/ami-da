use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
pub struct LadderSettings {
    pub lane_count: u32,
    pub total_height: f32,
}

#[derive(Serialize, Deserialize)]
pub struct RunnerState {
    pub lane: u32,
    pub y: f32,
    pub finished: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FullRunnerState {
    pub user_id: String,
    pub lane: i32,
    pub y: f64,
    pub speed: f64,
    pub reverse_until_ms: f64,
    pub speed_boost_until_ms: f64,
    pub invisible_until_ms: f64,
    pub vision_jammed_until_ms: f64,
    pub finished: bool,
    pub result_lane: Option<i32>,
}

#[derive(Serialize, Deserialize)]
pub struct SkillProposalPayload {
    pub lane_left: Option<i32>,
    pub rung_id: Option<String>,
    pub y: Option<f64>,
    pub duration_ms: Option<f64>,
}

#[derive(Serialize, Deserialize)]
pub struct SkillProposal {
    pub kind: String,
    pub proposal_id: String,
    pub from_user_id: String,
    pub target_user_id: String,
    pub skill: String,
    pub payload: SkillProposalPayload,
    pub client_time_ms: f64,
}

#[derive(Serialize, Deserialize)]
pub struct RuleSet {
    pub allowed_skills: Vec<String>,
    pub max_use_per_skill: std::collections::HashMap<String, i32>,
    pub cooldown_ms: std::collections::HashMap<String, i32>,
    pub protected_top_distance: i32,
    pub protected_bottom_distance: i32,
}

#[derive(Serialize, Deserialize)]
pub struct FullSettings {
    pub lane_count: i32,
    pub draw_names: Vec<String>,
    pub total_height: i32,
    pub seed: i32,
    pub rules: RuleSet,
}

#[derive(Serialize, Deserialize)]
pub struct WasmRuleInput {
    pub settings: FullSettings,
    pub runner: FullRunnerState,
    pub usage: std::collections::HashMap<String, i32>,
    pub last_use_ms: std::collections::HashMap<String, i64>,
    pub proposal: SkillProposal,
    pub now_ms: i64,
}

#[derive(Serialize, Deserialize)]
pub struct WasmRuleResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub lane: Option<i32>,
    pub y: Option<f64>,
    pub duration_ms: Option<f64>,
    pub speed_multiplier: Option<f64>,
    pub lane_left: Option<i32>,
}

#[wasm_bindgen]
pub struct LadderCore {
    settings: LadderSettings,
    runners: Vec<RunnerState>,
}

#[wasm_bindgen]
impl LadderCore {
    #[wasm_bindgen(constructor)]
    pub fn new(settings_js: JsValue) -> Result<LadderCore, JsValue> {
        let settings: LadderSettings = serde_wasm_bindgen::from_value(settings_js)?;
        Ok(LadderCore {
            settings,
            runners: Vec::new(),
        })
    }

    pub fn add_runner(&mut self, lane: u32) {
        self.runners.push(RunnerState {
            lane,
            y: 0.0,
            finished: false,
        });
    }

    pub fn tick(&mut self, dt_sec: f32) {
        for runner in &mut self.runners {
            if runner.finished {
                continue;
            }
            runner.y += dt_sec * 120.0;
            if runner.y >= self.settings.total_height {
                runner.y = self.settings.total_height;
                runner.finished = true;
            }
        }
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.runners).map_err(Into::into)
    }
}

#[wasm_bindgen]
pub fn validate_skill(input_js: JsValue) -> Result<JsValue, JsValue> {
    let input: WasmRuleInput = serde_wasm_bindgen::from_value(input_js)?;

    let skill = input.proposal.skill.clone();
    if !input.settings.rules.allowed_skills.iter().any(|s| s == &skill) {
        return ok_result(false, Some("skill not allowed".to_string()), None, None, None, None, None);
    }

    let used = *input.usage.get(&skill).unwrap_or(&0);
    let max_use = *input.settings.rules.max_use_per_skill.get(&skill).unwrap_or(&0);
    if used >= max_use {
        return ok_result(false, Some("usage limit".to_string()), None, None, None, None, None);
    }

    let last_use = *input.last_use_ms.get(&skill).unwrap_or(&0);
    let cooldown = *input.settings.rules.cooldown_ms.get(&skill).unwrap_or(&0) as i64;
    if input.now_ms - last_use < cooldown {
        return ok_result(false, Some("cooldown".to_string()), None, None, None, None, None);
    }

    let top = input.settings.rules.protected_top_distance as f64;
    let bottom = input.settings.total_height as f64 - input.settings.rules.protected_bottom_distance as f64;
    if input.runner.y < top || input.runner.y > bottom {
        return ok_result(false, Some("protected range".to_string()), None, None, None, None, None);
    }

    let mut lane = None;
    let mut y = None;
    let mut duration = input.proposal.payload.duration_ms;
    let mut speed_multiplier: Option<f64> = None;
    let mut lane_left: Option<i32> = None;

    if skill == "add_rung" {
        let raw = input.proposal.payload.lane_left
            .unwrap_or_else(|| (input.runner.lane - 1).max(0));
        lane_left = Some(raw.clamp(0, input.settings.lane_count - 2));
        y = Some(
            input.proposal.payload.y
                .unwrap_or(input.runner.y)
                .clamp(top, bottom),
        );
    }

    if skill == "warp" {
        let target_lane = input.proposal.payload.lane_left.unwrap_or(input.runner.lane);
        if target_lane < 0 || target_lane >= input.settings.lane_count {
            return ok_result(false, Some("invalid warp lane".to_string()), None, None, None, None, None);
        }
        lane = Some(target_lane);
        y = Some(input.proposal.payload.y.unwrap_or(input.runner.y + 80.0));
    }

    if skill == "jump" {
        let delta = input.proposal.payload.lane_left.unwrap_or(2).abs().max(1);
        let target_lane = (input.runner.lane + delta).clamp(0, input.settings.lane_count - 1);
        lane = Some(target_lane);
        y = Some((input.runner.y + 45.0).min(input.settings.total_height as f64));
    }

    if skill == "reverse" {
        duration = Some(input.proposal.payload.duration_ms.unwrap_or(2200.0));
    }

    if skill == "speed_boost" {
        duration = Some(input.proposal.payload.duration_ms.unwrap_or(1600.0));
        // 使用回数が増えるほど倍率が逓減 (1.8 → 1.65 → 1.5 … 最低 1.2)
        let uses = *input.usage.get(&skill).unwrap_or(&0);
        speed_multiplier = Some((1.8_f64 - uses as f64 * 0.15_f64).max(1.2_f64));
    }

    if skill == "cloak" {
        duration = Some(input.proposal.payload.duration_ms.unwrap_or(2600.0));
    }

    if skill == "vision_jam" {
        duration = Some(input.proposal.payload.duration_ms.unwrap_or(2800.0));
    }

    ok_result(true, None, lane, lane_left, y, duration, speed_multiplier)
}

fn ok_result(
    ok: bool,
    reason: Option<String>,
    lane: Option<i32>,
    lane_left: Option<i32>,
    y: Option<f64>,
    duration_ms: Option<f64>,
    speed_multiplier: Option<f64>,
) -> Result<JsValue, JsValue> {
    let out = WasmRuleResult {
        ok,
        reason,
        lane,
        y,
        duration_ms,
        speed_multiplier,
        lane_left,
    };
    serde_wasm_bindgen::to_value(&out).map_err(Into::into)
}

