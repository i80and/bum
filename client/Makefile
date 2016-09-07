.PHONY: all clean

SRC=./src/main.ts ./src/media.ts

all: ./build/app.js ./build/index.html
	rsync -ra --delete style/ build/style

./build/app.js: $(SRC) Makefile node_modules
	./node_modules/.bin/rollup -c

./build/index.html: index.html
	cp $^ $@

node_modules: package.json
	npm install

clean:
	rm -r build/*
