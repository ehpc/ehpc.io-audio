.PHONY: lint run

lint:
	ruff format .
	ruff check --fix .
	ty check

run:
	@test -n "$(URL)$(FILE)" || (echo "usage: make run URL=https://... or FILE=/file.mp3 [DECROWD=1] [DEREVERB=1] [CHORUS=1] [VOCALISTS=1] [DRUMS=1] [NOCACHE=1]" && exit 1)
	uv run modal run modal_separate.py \
		$(if $(URL),--url "$(URL)") \
		$(if $(FILE),--path "$(FILE)") \
		$(if $(DECROWD),--decrowd) \
		$(if $(DEREVERB),--dereverb) \
		$(if $(CHORUS),--chorus) \
		$(if $(VOCALISTS),--vocalists) \
		$(if $(DRUMS),--drums) \
		$(if $(NOCACHE),--no-cache)
