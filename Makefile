COMPOSE  := docker compose
PSQL     := $(COMPOSE) exec -T postgres psql -U jol -d jol
SERVICES := accounts fleet pricing dispatch intercity realtime
BACKUPS  := backups
DRIVERS  ?= 1000

.DEFAULT_GOAL := help
.PHONY: help up down restart rebuild ps logs health psql test typecheck e2e bench backup restore map-reset clean

help: ## Показать список команд
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Собрать и запустить весь стек (первый раз ещё готовит карту)
	@[ -f .env ] || cp .env.example .env
	$(COMPOSE) up -d --build --wait --wait-timeout 900
	@echo "Пассажир: http://localhost:8080/"
	@echo "Водитель: http://localhost:8080/driver.html"

down: ## Остановить (данные остаются)
	$(COMPOSE) down

restart: ## Перезапустить сервис: make restart S=dispatch
	$(COMPOSE) restart $(or $(S),$(SERVICES))

rebuild: ## Пересобрать и перезапустить сервис: make rebuild S=pricing
	$(COMPOSE) up -d --build $(or $(S),$(SERVICES))

ps: ## Статус контейнеров
	$(COMPOSE) ps -a

logs: ## Логи: make logs S=dispatch (по умолчанию все сервисы)
	$(COMPOSE) logs -f --tail=100 $(or $(S),$(SERVICES))

health: ## Готовность каждого сервиса (/readyz)
	@for s in $(SERVICES); do printf "%-10s " $$s; $(COMPOSE) exec -T $$s wget -qO- http://127.0.0.1:8080/readyz || echo " не готов"; echo; done

psql: ## Консоль PostgreSQL
	$(COMPOSE) exec postgres psql -U jol -d jol

typecheck: ## Проверка типов всего монорепозитория
	npm run build

test: ## Юнит-тесты
	npm test

e2e: ## Сквозной тест против запущенного стека
	node scripts/e2e.mjs

bench: ## Нагрузочный тест: make bench DRIVERS=5000
	docker run --rm --network jol_default -v "$(CURDIR)/scripts:/scripts:ro" node:22-alpine node /scripts/bench.js $(DRIVERS)
	@$(PSQL) -qc "DELETE FROM accounts.drivers WHERE id LIKE 'bench-%'"

backup: ## Дамп базы в backups/
	@mkdir -p $(BACKUPS)
	$(COMPOSE) exec -T postgres pg_dump -U jol -d jol -Fc > $(BACKUPS)/jol-$$(date +%Y%m%d-%H%M%S).dump
	@ls -lh $(BACKUPS) | tail -1

restore: ## Восстановить базу: make restore FILE=backups/....dump
	@[ -n "$(FILE)" ] || (echo "Укажите FILE=backups/имя.dump" && exit 1)
	$(COMPOSE) stop $(SERVICES)
	$(COMPOSE) exec -T postgres pg_restore -U jol -d jol --clean --if-exists < $(FILE)
	$(COMPOSE) start $(SERVICES)

map-reset: ## Скачать свежую карту Казахстана и пересобрать маршруты
	$(COMPOSE) stop osrm
	$(COMPOSE) run --rm --no-deps --entrypoint sh osrm-prepare -c 'rm -f /data/kz.*'
	$(COMPOSE) up -d osrm

clean: ## Удалить контейнеры и ВСЕ данные (спросит подтверждение)
	@read -p "Удалить базу, события и карту без возможности восстановления? [y/N] " ans && [ "$$ans" = y ]
	$(COMPOSE) down -v
