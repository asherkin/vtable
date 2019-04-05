DEBUG ?= 0
GIT_REMOTE := $(shell git ls-remote --get-url)
EMCC_OPTIONS := -s SINGLE_FILE=1 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s NO_FILESYSTEM=1 -s "EXPORTED_FUNCTIONS=['___cxa_demangle','_malloc','_free']" -s "EXTRA_EXPORTED_RUNTIME_METHODS=['getValue','lengthBytesUTF8','UTF8ToString','stringToUTF8']"

MAKEFLAGS += --no-builtin-rules
.SUFFIXES:

vtable.js: main.cpp build-libelf/lib/libelf.a is_debug
ifeq ($(DEBUG), 1)
	em++ --bind --std=c++14 -s ASSERTIONS=2 -s SAFE_HEAP=1 -s WARN_UNALIGNED=1 $(EMCC_OPTIONS) -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
else
	em++ --bind --std=c++14 -O3 --llvm-lto 1 --closure 1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 $(EMCC_OPTIONS) -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
endif

vtable: main.cpp build-libelf-native/lib/libelf.a is_debug
ifeq ($(DEBUG), 1)
	$(CXX) -m32 --std=c++14 -g -Ibuild-libelf-native/lib -Ilibelf-0.8.13/lib -o vtable main.cpp build-libelf-native/lib/libelf.a
else
	$(CXX) -m32 --std=c++14 -O3 -Ibuild-libelf-native/lib -Ilibelf-0.8.13/lib -o vtable main.cpp build-libelf-native/lib/libelf.a
endif

.PHONY: force clean distclean test deploy

is_debug: force
	@echo '$(DEBUG)' | cmp -s - $@ || echo '$(DEBUG)' > $@

deploy: gh-pages
	cd gh-pages && rm -rf .git && git init && git add . && git commit -m 'Deploy to GitHub Pages'
	@cd gh-pages && git push --force --quiet '$(GIT_REMOTE)' master:gh-pages > /dev/null 2>&1 && echo 'Site deployed to GitHub Pages!'

gh-pages: index.html worker.js vtable.js
	rm -rf gh-pages
	mkdir -p gh-pages
	cp $^ gh-pages/

clean:
	rm -rf vtable.js vtable gh-pages is_debug

distclean: clean
	rm -rf build-libelf build-libelf-native libelf-0.8.13 libelf-0.8.13.tar.gz

test: test.js vtable.js test/test-32 test/test-64
	node test.js test/test-32
	node test.js test/test-64

build-libelf/lib/libelf.a: export CFLAGS = -m32
build-libelf/lib/libelf.a: export CXXFLAGS = -m32
build-libelf/lib/libelf.a: export LDFLAGS = -m32
build-libelf/lib/libelf.a: build-libelf libelf-0.8.13
	cd build-libelf && emconfigure ../libelf-0.8.13/configure --build=i686-linux-gnu --enable-shared=no && emmake make

build-libelf:
	mkdir -p build-libelf

build-libelf-native/lib/libelf.a: build-libelf-native libelf-0.8.13
	cd build-libelf-native && ../libelf-0.8.13/configure --build=i686-linux-gnu --enable-shared=no && make

build-libelf-native:
	mkdir -p build-libelf-native

libelf-0.8.13: libelf-0.8.13.tar.gz
	tar -xzf libelf-0.8.13.tar.gz && touch libelf-0.8.13

libelf-0.8.13.tar.gz:
	curl -Lo libelf-0.8.13.tar.gz 'https://fennec.limetech.io/libelf-0.8.13.tar.gz'
