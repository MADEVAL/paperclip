# Example — compressing a debugging reply

## Input

User asks:

> Our HTTP server sometimes returns 502 under load. Logs show `upstream timed out (110: Connection timed out) while reading response header from upstream`. Where should I look?

The agent runs `grep -rn "proxy_read_timeout" deploy/`, reads the Nginx config, then answers.

## Normal prose (no skill)

> Sure! Happy to help. The reason you're seeing 502s under load is most likely that
> Nginx is giving up on the upstream response too early. By default `proxy_read_timeout`
> is 60 seconds, but if you've set it lower, or if your app's p99 latency under load
> exceeds it, Nginx will return 502 while the upstream is still working. I'd recommend
> checking the timeout value in your Nginx config and raising it, then re-testing under
> the same load.

## caveman lite

Filler and hedging removed. Full sentences and articles kept.

> Nginx returns 502 when the upstream response exceeds `proxy_read_timeout`. The
> default is 60s. Check the value in `deploy/nginx.conf`, raise it above your p99
> latency, then re-run the load test.

## caveman full (default)

Articles dropped, fragments allowed, short synonyms. Payload stays exact.

> 502 = Nginx gave up on upstream before `proxy_read_timeout`. Default 60s.
> `deploy/nginx.conf` sets it lower. Raise above p99, re-test under load.

## caveman ultra

Conjunctions stripped where meaning stays unambiguous. Each fact once.

> 502, `proxy_read_timeout` < upstream p99. `deploy/nginx.conf`. Raise, re-test.

## What stayed exact in every mode

- The error meaning: Nginx timed out waiting on the upstream.
- The config key `proxy_read_timeout` (never renamed).
- The file path `deploy/nginx.conf`.
- The next step: raise the timeout above p99, then re-test under load.

## Auto-clarity in action

If the same task were "raise `proxy_read_timeout` in production", the confirmation
drops to plain prose first:

> This changes a production Nginx setting and needs a reload. Confirm the target
> value and window, then I will apply it.

Caveman resumes after the confirmation.
