COMPOSE  := docker compose
PSQL     := $(COMPOSE) exec -T postgres psql -U taxi -d taxi
BACKUPS  := backups
DRIVERS  ?= 1000

.DEFAULT_GOAL := help
.PHONY: help up down restart rebuild ps logs logs-osrm health psql backup restore map-reset bench dev clean

help: ## Показать список команд
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Собрать и запустить всё (первый раз ещё скачает и подготовит карту)
	@[ -f .env ] || cp .env.example .env
	$(COMPOSE) up -d --build
	@echo "Пассажир: http://localhost:8080/"
	@echo "Водитель: http://localhost:8080/driver.html"

down: ## Остановить все контейнеры (данные остаются)
	$(COMPOSE) down

restart: ## Перезапустить сервер приложения
	$(COMPOSE) restart taxi

rebuild: ## Пересобрать и перезапустить только приложение
	$(COMPOSE) up -d --build taxi

ps: ## Статус контейнеров
	$(COMPOSE) ps -a

logs: ## Логи приложения в реальном времени
	$(COMPOSE) logs -f --tail=100 taxi

logs-osrm: ## Логи скачивания и подготовки карты
	$(COMPOSE) logs -f osrm-download osrm-prepare osrm

health: ## Проверить, что приложение и маршрутизация отвечают
	@curl -fsS http://localhost:8080/api/health && echo " приложение OK"
	@curl -fsS "http://localhost:8080/osrm/route/v1/driving/76.889,43.238;76.92,43.25?overview=false" | grep -q '"Ok"' && echo "OSRM OK"

psql: ## Открыть консоль PostgreSQL
	$(COMPOSE) exec postgres psql -U taxi -d taxi

backup: ## Сделать дамп базы в backups/
	@mkdir -p $(BACKUPS)
	$(COMPOSE) exec -T postgres pg_dump -U taxi -d taxi -Fc > $(BACKUPS)/taxi-$$(date +%Y%m%d-%H%M%S).dump
	@ls -lh $(BACKUPS) | tail -1

restore: ## Восстановить базу из дампа: make restore FILE=backups/....dump
	@[ -n "$(FILE)" ] || (echo "Укажите FILE=backups/имя.dump" && exit 1)
	$(COMPOSE) stop taxi
	$(COMPOSE) exec -T postgres pg_restore -U taxi -d taxi --clean --if-exists < $(FILE)
	$(COMPOSE) start taxi

map-reset: ## Скачать свежую карту Казахстана и пересобрать маршруты
	$(COMPOSE) stop osrm
	$(COMPOSE) run --rm --no-deps --entrypoint sh osrm-prepare -c 'rm -f /data/kz.*'
	$(COMPOSE) up -d osrm

bench: ## Нагрузочный тест: make bench DRIVERS=5000
	node scripts/bench.js $(DRIVERS)
	@$(PSQL) -qc "DELETE FROM drivers WHERE id LIKE 'bench-%'"

dev: ## Запустить сервер без Docker (нужен DATABASE_URL)
	node server.js

clean: ## Удалить контейнеры И ВСЕ ДАННЫЕ (базу и карту)
	@read -p "Удалить базу и карту без возможности восстановления? [y/N] " ans && [ "$$ans" = y ]
	$(COMPOSE) down -v
