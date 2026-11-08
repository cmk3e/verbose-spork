// Solve single-raised-pot flops and export flop-decision strategies + EVs as JSON
// for the Postflop Framework Drills app.
//
// usage: export_flops <ranges.txt> <pot_tenths_bb> <stack_tenths_bb> <out_dir> <flop> [<flop> ...]
//   ranges.txt: line 1 = IP range, line 2 = OOP range, solver range syntax.
//   env FLOP_OOP / FLOP_IP override the flop bet sizes (defaults "33%" / "33%, 75%").
// Exported nodes: root (OOP first), b1/b2 (IP facing OOP's bets), x (IP after a check),
//   x-b1/x-b2 (OOP facing IP's bets after checking).
use postflop_solver::*;
use std::fmt::Write as _;
use std::time::Instant;

fn action_label(a: &Action, unit: f32) -> String {
    match a {
        Action::Fold => "Fold".into(),
        Action::Check => "Check".into(),
        Action::Call => "Call".into(),
        Action::Bet(x) => format!("Bet {:.1}", *x as f32 / unit),
        Action::Raise(x) => format!("Raise {:.1}", *x as f32 / unit),
        Action::AllIn(x) => format!("All-in {:.1}", *x as f32 / unit),
        _ => format!("{:?}", a),
    }
}

fn export_node(game: &mut PostFlopGame, path: &[usize], name: &str, unit: f32, out: &mut String) {
    game.back_to_root();
    game.apply_history(path);
    game.cache_normalized_weights();
    let player = game.current_player();
    let actions = game.available_actions();
    let strat = game.strategy();
    let ev = game.expected_values_detail(player);
    let w = game.normalized_weights(player);
    let hands = holes_to_strings(game.private_cards(player)).unwrap();
    let n = hands.len();
    let pot = {
        let b = game.total_bet_amount();
        game.tree_config().starting_pot as f32 + (b[0] + b[1]) as f32
    };
    let _ = write!(out, "\"{}\":{{\"player\":\"{}\",\"pot\":{:.1},\"actions\":[", name, if player == 0 { "OOP" } else { "IP" }, pot / unit);
    for (i, a) in actions.iter().enumerate() {
        let _ = write!(out, "{}\"{}\"", if i > 0 { "," } else { "" }, action_label(a, unit));
    }
    out.push_str("],\"hands\":{");
    let mut first = true;
    for i in 0..n {
        if w[i] <= 0.0 {
            continue;
        }
        // "AhKd":[weight, f1, ev1, f2, ev2, ...]  freq in %, EV in bb
        let _ = write!(out, "{}\"{}\":[{:.2}", if first { "" } else { "," }, hands[i], w[i]);
        first = false;
        for a in 0..actions.len() {
            let _ = write!(out, ",{:.0},{:.2}", strat[a * n + i] * 100.0, ev[a * n + i] / unit);
        }
        out.push(']');
    }
    out.push_str("}}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let txt = std::fs::read_to_string(&args[1]).unwrap();
    let mut lines = txt.lines();
    let ip = lines.next().unwrap();
    let oop = lines.next().unwrap();
    let pot: i32 = args[2].parse().unwrap();
    let stack: i32 = args[3].parse().unwrap();
    let out_dir = &args[4];
    let unit = 10.0; // amounts are in tenths of a big blind
    std::fs::create_dir_all(out_dir).unwrap();

    for flop in &args[5..] {
        let t = Instant::now();
        let card_config = CardConfig {
            range: [oop.parse().unwrap(), ip.parse().unwrap()],
            flop: flop_from_str(flop).unwrap(),
            turn: NOT_DEALT,
            river: NOT_DEALT,
        };
        let ip_sizes = std::env::var("FLOP_IP").unwrap_or("33%, 75%".into());
        let oop_sizes = std::env::var("FLOP_OOP").unwrap_or("33%".into());
        let flop_ip = BetSizeOptions::try_from((ip_sizes.as_str(), "3x")).unwrap();
        let flop_oop = BetSizeOptions::try_from((oop_sizes.as_str(), "3x")).unwrap();
        let later = BetSizeOptions::try_from(("66%", "3x")).unwrap();
        let tree_config = TreeConfig {
            initial_state: BoardState::Flop,
            starting_pot: pot,
            effective_stack: stack,
            rake_rate: 0.0,
            rake_cap: 0.0,
            flop_bet_sizes: [flop_oop, flop_ip],
            turn_bet_sizes: [later.clone(), later.clone()],
            river_bet_sizes: [later.clone(), later],
            turn_donk_sizes: None,
            river_donk_sizes: None,
            add_allin_threshold: 1.5,
            force_allin_threshold: 0.15,
            merging_threshold: 0.1,
        };
        let tree = ActionTree::new(tree_config).unwrap();
        let mut game = PostFlopGame::with_config(card_config, tree).unwrap();
        let (_, mem) = game.memory_usage();
        game.allocate_memory(true);
        let target = pot as f32 * 0.005;
        let expl = solve(&mut game, 600, target, false);
        let secs = t.elapsed().as_secs_f64();

        let mut out = String::new();
        let _ = write!(
            out,
            "{{\"flop\":\"{}\",\"pot\":{:.1},\"stack\":{:.1},\"exploitability\":{:.3},\"seconds\":{:.0},\"nodes\":{{",
            flop, pot as f32 / unit, stack as f32 / unit, expl / pot as f32 * 100.0, secs
        );
        // root: OOP acts
        export_node(&mut game, &[], "root", unit, &mut out);
        // find OOP check, then IP's options
        game.back_to_root();
        let root_actions = game.available_actions();
        let root_bets: Vec<usize> = root_actions
            .iter()
            .enumerate()
            .filter(|(_, a)| matches!(a, Action::Bet(_)))
            .map(|(i, _)| i)
            .collect();
        for (k, bi) in root_bets.iter().take(2).enumerate() {
            out.push(',');
            export_node(&mut game, &[*bi], if k == 0 { "b1" } else { "b2" }, unit, &mut out);
        }
        game.back_to_root();
        if let Some(ci) = root_actions.iter().position(|a| *a == Action::Check) {
            out.push(',');
            export_node(&mut game, &[ci], "x", unit, &mut out);
            game.back_to_root();
            game.play(ci);
            let ip_actions = game.available_actions();
            let bets: Vec<usize> = ip_actions
                .iter()
                .enumerate()
                .filter(|(_, a)| matches!(a, Action::Bet(_) | Action::AllIn(_)))
                .map(|(i, _)| i)
                .collect();
            for (k, bi) in bets.iter().enumerate() {
                out.push(',');
                let name = if k == 0 { "x-b1" } else { "x-b2" };
                export_node(&mut game, &[ci, *bi], name, unit, &mut out);
                if k == 1 {
                    break;
                }
            }
        }
        out.push_str("}}");
        let file = format!("{}/{}.json", out_dir, flop);
        std::fs::write(&file, out).unwrap();
        println!(
            "{}: {:.0}s, exploitability {:.2}% pot, mem {:.2}GB",
            flop,
            secs,
            expl / pot as f32 * 100.0,
            mem as f64 / 1e9
        );
    }
}
