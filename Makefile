DEBUG ?= 0
GIT_REMOTE := $(shell git ls-remote --get-url)

MAKEFLAGS += --no-builtin-rules
.SUFFIXES:

vtable.js: main.cpp build-libelf/lib/libelf.a is_debug
ifeq ($(DEBUG), 1)
	em++ --bind --std=c++14 --memory-init-file 0 -s ASSERTIONS=2 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s SAFE_HEAP=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
else
	em++ --bind --std=c++14 -O3 --llvm-lto 1 --closure 1 --memory-init-file 0 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
endif

.PHONY: force clean distclean test deploy

is_debug: force
	@echo '$(DEBUG)' | cmp -s - $@ || echo '$(DEBUG)' > $@

deploy: gh-pages
	cd gh-pages && rm -rf .git && git init && git add . && git commit -m 'Deploy to GitHub Pages'
	@cd gh-pages && git push --force --quiet '$(GIT_REMOTE)' master:gh-pages > /dev/null 2>&1 && echo 'Site deployed to GitHub Pages!'

gh-pages: index.html test.html vtable.js
	rm -rf gh-pages
	mkdir -p gh-pages
	cp $^ gh-pages/

clean:
	rm -rf vtable.js gh-pages is_debug

distclean: clean
	rm -rf build-libelf libelf-0.8.13 libelf-0.8.13.tar.gz engine_srv.so

test: test.js vtable.js engine_srv.so
	node test.js

engine_srv.so:
	curl -o engine_srv.so 'https://fennec.limetech.org/vtable-test/engine_srv.so'

build-libelf/lib/libelf.a: export CFLAGS = -m32
build-libelf/lib/libelf.a: export CXXFLAGS = -m32
build-libelf/lib/libelf.a: export LDFLAGS = -m32
build-libelf/lib/libelf.a: build-libelf libelf-0.8.13
	cd build-libelf && emconfigure ../libelf-0.8.13/configure --build=i686-linux-gnu --enable-shared=no && emmake make

build-libelf:
	mkdir -p build-libelf

libelf-0.8.13: libelf-0.8.13.tar.gz
	tar -xzf libelf-0.8.13.tar.gz && touch libelf-0.8.13

libelf-0.8.13.tar.gz:
	curl -o libelf-0.8.13.tar.gz 'https://fennec.limetech.org/libelf-0.8.13.tar.gz'
